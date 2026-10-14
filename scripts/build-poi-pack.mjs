#!/usr/bin/env node
// Builds an offline places pack for one region: food and drink POIs from
// OpenStreetMap (Overpass JSON or an osmium export) plus the Eat/Drink listings
// of the region's Wikivoyage guides, with a grid index for "near me" and FTS
// for names and cuisines. See docs/POI_PACKS.md.
//
//   node scripts/build-poi-pack.mjs --id sao-paulo --name-en "São Paulo" --name-pt "São Paulo" \
//     --bbox=-23.80,-46.83,-23.36,-46.36 --tz America/Sao_Paulo --osm osm-sao-paulo.json \
//     --voyage enwikivoyage-latest-pages-articles.xml.bz2 --voyage-title "São Paulo" --out poi/sao-paulo.sqlite
//
// OSM data is ODbL 1.0 (© OpenStreetMap contributors); Wikivoyage is CC BY-SA 4.0.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PoiPackWriter, voyageEatDrink } from "./lib/poi-writer.mjs";

const { values: o } = parseArgs({
  options: {
    id: { type: "string" },
    "name-en": { type: "string" },
    "name-pt": { type: "string" },
    bbox: { type: "string" },
    tz: { type: "string", multiple: true, default: [] },
    osm: { type: "string", multiple: true, default: [] },
    voyage: { type: "string" },
    "voyage-title": { type: "string", multiple: true, default: [] },
    places: { type: "string" },
    "diet-check": { type: "string" },
    out: { type: "string" },
  },
});
if (!o.id || !o.bbox || !o.out || !o.osm.length) {
  console.error("usage: build-poi-pack.mjs --id ID --bbox=minLat,minLon,maxLat,maxLon --osm FILE.json --out FILE [--voyage DUMP --voyage-title T] [--places world-places.sqlite]");
  process.exit(1);
}
const bbox = o.bbox.split(",").map(Number);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const inBox = (lat, lon) => lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3];

const w = new PoiPackWriter(o.out, { dietChecks: o["diet-check"] ? JSON.parse(readFileSync(o["diet-check"], "utf8")) : {} });
const osmDates = [];
for (const file of o.osm) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (j.osm3s?.timestamp_osm_base) osmDates.push(j.osm3s.timestamp_osm_base);
  for (const e of j.elements ?? []) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    // --bbox also cuts: a city pack can be built from its region's OSM export.
    if (lat != null && inBox(lat, lon)) w.addOsm(e, lat, lon);
  }
}
// Wikivoyage: the region's guide and its districts ("São Paulo", "São Paulo/Centro", ...).
if (o.voyage && o["voyage-title"].length) {
  const wanted = (title) => o["voyage-title"].some((t) => title === t || title.startsWith(`${t}/`));
  for await (const item of voyageEatDrink(o.voyage, wanted)) if (inBox(item.lat, item.lon)) w.addListing(item);
  log(`wikivoyage: ${w.stats.voyage} listings (${w.stats.voyageApprox} without their own coordinates)`);
}
const summary = await w.finish(
  {
    id: o.id,
    nameEn: o["name-en"] ?? o.id,
    namePt: o["name-pt"] ?? o["name-en"] ?? o.id,
    bbox: JSON.stringify(bbox),
    timeZones: JSON.stringify(o.tz),
    osmDate: osmDates.sort()[0] ?? "",
    voyageDump: o.voyage ? o.voyage.split("/").pop() : "",
  },
  { placesPath: o.places, bbox }
);
console.log(JSON.stringify(summary, null, 2));
