#!/usr/bin/env node
// Places packs for the world, one per 1°×1° tile, from Geofabrik extracts
// (docs/POI_PACKS.md). Three steps, each resumable:
//
//   extract  download each extract, keep only food and drink places with osmium,
//            save them as <work>/extracts/<id>.jsonl.gz, delete the .pbf
//            (so disk use peaks at one extract)
//   tiles    group every place (deduped across extracts) into 1° tiles and write
//            <work>/tiles/t-N41E012.sqlite with the Wikivoyage Eat/Drink listings
//            of the same area and the diet audit (scripts/audit-poi-diet.mjs)
//   index    <work>/tiles/index.json: id, bbox, size, SHA-256 and counts per tile
//
//   node scripts/build-poi-world.mjs extract --work W --leaves leaves.json --continents europe,asia
//        [--only yunnan,vietnam] [--exclude us,us-south]   (ids; --only keeps its own order)
//   node scripts/build-poi-world.mjs tiles --work W --voyage enwikivoyage.xml.bz2 --places world-places.sqlite [--diet-check f.json]
//   node scripts/build-poi-world.mjs index --work W
//
// leaves.json: Geofabrik's index-v1.json features without children
// ([{ id, name, continent, pbf }]). Needs osmium-tool and curl.
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import { PoiPackWriter, voyageEatDrink } from "./lib/poi-writer.mjs";
import { lines } from "./lib/lines.mjs";
import { tileId, tileOf } from "./lib/poi-pack-lib.mjs";

const [step] = process.argv.slice(2, 3);
const { values: o } = parseArgs({
  args: process.argv.slice(3),
  options: {
    work: { type: "string" },
    leaves: { type: "string" },
    continents: { type: "string", default: "" },
    only: { type: "string", default: "" },
    exclude: { type: "string", default: "" },
    voyage: { type: "string" },
    places: { type: "string" },
    "diet-check": { type: "string" },
    "min-free-gb": { type: "string", default: "20" },
  },
});
if (!o.work || !["extract", "tiles", "index"].includes(step)) {
  console.error("usage: build-poi-world.mjs extract|tiles|index --work DIR [...]");
  process.exit(1);
}
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const EXTRACTS = join(o.work, "extracts");
const TILES = join(o.work, "tiles");
mkdirSync(EXTRACTS, { recursive: true });
mkdirSync(TILES, { recursive: true });

// The same food and drink places as the Overpass query in docs/POI_PACKS.md.
const FILTER = [
  "nwr/amenity=restaurant,cafe,fast_food,food_court,bar,pub,biergarten,ice_cream",
  "nwr/shop=bakery,deli,confectionery,pastry",
  "nwr/diet:vegan=yes,only,limited",
];

const freeGb = () => {
  const s = statfsSync(o.work);
  return (s.bavail * s.bsize) / 1e9;
};

/** GeoJSON geometry → a representative point: the point itself, or the middle of its bounding box. */
function pointOf(g) {
  if (g.type === "Point") return g.coordinates;
  const flat = [];
  const walk = (c) => (typeof c[0] === "number" ? flat.push(c) : c.forEach(walk));
  walk(g.coordinates);
  if (!flat.length) return null;
  const lons = flat.map((c) => c[0]);
  const lats = flat.map((c) => c[1]);
  return [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}

async function extract() {
  const ids = (s) => s.split(",").filter(Boolean);
  const want = new Set(ids(o.continents));
  const skip = new Set(ids(o.exclude));
  let leaves = JSON.parse(readFileSync(o.leaves, "utf8")).filter((l) => (!want.size || want.has(l.continent)) && !skip.has(l.id));
  if (o.only) {
    const byId = new Map(leaves.map((l) => [l.id, l]));
    leaves = ids(o.only).map((id) => byId.get(id)).filter(Boolean);
  }
  log(`${leaves.length} extracts`);
  for (const [i, leaf] of leaves.entries()) {
    const out = join(EXTRACTS, `${leaf.id.replace(/\//g, "_")}.jsonl.gz`);
    if (existsSync(out)) continue;
    while (freeGb() < Number(o["min-free-gb"])) {
      log(`PAUSED: ${freeGb().toFixed(1)} GB free`);
      await new Promise((r) => setTimeout(r, 60000));
    }
    const pbf = join(o.work, "current.osm.pbf");
    const food = join(o.work, "current-food.osm.pbf");
    const geo = join(o.work, "current-food.geojsonseq");
    // A partial download resumes only if it is this extract's: resuming another one's (a run stopped mid-download,
    // then restarted with other --only/--continents) asks for a range past the end and curl retries for an hour.
    const owner = `${pbf}.url`;
    if (existsSync(pbf) && (!existsSync(owner) || readFileSync(owner, "utf8") !== leaf.pbf)) rmSync(pbf);
    writeFileSync(owner, leaf.pbf);
    execFileSync("curl", ["-fsSL", "-C", "-", "--retry", "20", "--retry-all-errors", "-o", pbf, leaf.pbf]);
    // A download resumed after a long pause (the job is paused while the machine builds) can end up corrupt
    // ("invalid BlobHeader size"): start that extract over once instead of stopping the whole run.
    try {
      execFileSync("osmium", ["tags-filter", "--overwrite", "-o", food, pbf, ...FILTER], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      log(`${leaf.id}: unreadable download (${String(e.stderr ?? e.message).trim().slice(0, 80)}), downloading again`);
      rmSync(pbf, { force: true });
      execFileSync("curl", ["-fsSL", "--retry", "20", "--retry-all-errors", "-o", pbf, leaf.pbf]);
      try {
        execFileSync("osmium", ["tags-filter", "--overwrite", "-o", food, pbf, ...FILTER], { stdio: ["ignore", "ignore", "pipe"] });
      } catch {
        // Still not a PBF (Geofabrik answers some retired regions with an HTML page and status 200): skip the region,
        // record it, and go on; its parent region's neighbours cover most of it.
        const head = readFileSync(pbf, { encoding: "utf8", flag: "r" }).slice(0, 15);
        log(`${leaf.id}: SKIPPED, not a PBF (${/<!doctype|<html/i.test(head) ? "the server sent an HTML page" : "unreadable twice"})`);
        appendFileSync(join(o.work, "skipped.txt"), `${leaf.id}\t${leaf.pbf}\n`);
        for (const f of [pbf, food, geo]) rmSync(f, { force: true });
        continue;
      }
    }
    const header = spawnSync("osmium", ["fileinfo", "-g", "header.option.osmosis_replication_timestamp", pbf], { encoding: "utf8" }).stdout.trim();
    execFileSync("osmium", ["export", "--overwrite", "-f", "geojsonseq", "-a", "type,id", "-o", geo, food]);
    const gz = createGzip();
    const tmp = `${out}.part`;
    const done = new Promise((r) => gz.pipe(createWriteStream(tmp)).on("finish", r));
    let n = 0;
    for await (const line of lines(createReadStream(geo))) {
      const f = JSON.parse(line.replace(/^\x1e/, ""));
      const p = f.geometry && pointOf(f.geometry);
      if (!p) continue;
      const { "@type": type, "@id": id, ...tags } = f.properties;
      gz.write(`${JSON.stringify({ type, id, lat: +p[1].toFixed(7), lon: +p[0].toFixed(7), tags, osmDate: header })}\n`);
      n++;
    }
    gz.end();
    await done;
    renameSync(tmp, out);
    for (const f of [pbf, food, geo]) rmSync(f, { force: true });
    log(`${i + 1}/${leaves.length} ${leaf.id}: ${n} places (${header || "no timestamp"})`);
  }
}

async function* readExtracts() {
  for (const f of readdirSync(EXTRACTS).filter((x) => x.endsWith(".jsonl.gz"))) {
    for await (const line of lines(createReadStream(join(EXTRACTS, f)).pipe(createGunzip()))) {
      if (line) yield JSON.parse(line);
    }
  }
}

async function tiles() {
  // Pass 1: split everything into 10° latitude bands on disk, so one band at a time fits in memory.
  const BANDS = join(o.work, "bands");
  rmSync(BANDS, { recursive: true, force: true });
  mkdirSync(BANDS);
  const bands = new Map();
  const band = (lat) => Math.floor(lat / 10);
  const write = (b, obj) => {
    if (!bands.has(b)) bands.set(b, createWriteStream(join(BANDS, `${b}.jsonl`)));
    bands.get(b).write(`${JSON.stringify(obj)}\n`);
  };
  let n = 0;
  for await (const e of readExtracts()) (write(band(e.lat), { k: "osm", ...e }), n++);
  if (o.voyage) for await (const item of voyageEatDrink(o.voyage)) write(band(item.lat), { k: "voyage", ...item });
  await Promise.all([...bands.values()].map((s) => new Promise((r) => s.end(r))));
  log(`${n} places in ${bands.size} latitude bands`);

  const dietChecks = o["diet-check"] ? JSON.parse(readFileSync(o["diet-check"], "utf8")) : {};
  let written = 0;
  for (const b of [...bands.keys()].sort((x, y) => x - y)) {
    const byTile = new Map();
    for await (const line of lines(createReadStream(join(BANDS, `${b}.jsonl`)))) {
      const r = JSON.parse(line);
      const t = tileId(...tileOf(r.lat, r.lon));
      if (!byTile.has(t)) byTile.set(t, []);
      byTile.get(t).push(r);
    }
    for (const [id, items] of byTile) {
      const osm = items.filter((r) => r.k === "osm");
      if (!osm.some((r) => r.tags?.name)) continue; // a tile of listings only, or unnamed places only, isn't worth a file
      const [la, lo] = tileOf(items[0].lat, items[0].lon);
      const w = new PoiPackWriter(join(TILES, `${id}.sqlite`), { dietChecks });
      for (const r of osm) w.addOsm(r, r.lat, r.lon);
      for (const r of items.filter((x) => x.k === "voyage")) w.addListing(r);
      const bbox = [la, lo, la + 1, lo + 1];
      await w.finish(
        { id, nameEn: `${Math.abs(la)}°${la >= 0 ? "N" : "S"} ${Math.abs(lo)}°${lo >= 0 ? "E" : "W"}`, bbox: JSON.stringify(bbox), timeZones: "[]",
          osmDate: osm.map((r) => r.osmDate).filter(Boolean).sort()[0] ?? "", voyageDump: o.voyage ? o.voyage.split("/").pop() : "" },
        { placesPath: o.places, bbox }
      );
      written++;
    }
    log(`band ${b * 10}°: ${byTile.size} tiles (${written} written so far)`);
  }
  rmSync(BANDS, { recursive: true, force: true });
}

const TILE_URL_BASE = process.env.TILE_URL_BASE?.replace(/\/$/, "");

function index() {
  const rows = readdirSync(TILES)
    .filter((f) => f.endsWith(".sqlite.json"))
    .map((f) => JSON.parse(readFileSync(join(TILES, f), "utf8")))
    .map((s) => ({
      id: s.id, sizeBytes: s.sizeBytes, sha256: s.sha256, pois: s.osm + s.voyage, vegan: s.vegan, osmDate: s.osmDate,
      // TILE_URL_BASE: the hosted tiles, pinned to their upload commit (…/resolve/<sha>/places/tiles).
      ...(TILE_URL_BASE ? { url: `${TILE_URL_BASE}/${s.id}.sqlite` } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(TILES, "index.json"), `${JSON.stringify(rows)}\n`);
  const total = rows.reduce((s, r) => s + r.sizeBytes, 0);
  log(`${rows.length} tiles, ${(total / 1e9).toFixed(2)} GB, ${rows.reduce((s, r) => s + r.pois, 0)} places`);
}

if (step === "extract") await extract();
else if (step === "tiles") await tiles();
else index();
