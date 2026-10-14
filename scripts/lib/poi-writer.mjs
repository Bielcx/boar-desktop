// Writes one places pack (format "boar-poi-pack" v1): shared by build-poi-pack.mjs
// (one region) and build-poi-world.mjs (1° tiles). See docs/POI_PACKS.md.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addressOf, categoryOf, cellOf, cuisinesOf, dietOf, voyageListings } from "./poi-pack-lib.mjs";
import { parseDumpPage } from "./wiki-pack-lib.mjs";

export const POI_LICENSE = "ODbL 1.0 (© OpenStreetMap contributors) + CC BY-SA 4.0 (Wikivoyage)";

export class PoiPackWriter {
  /** `dietChecks`: { "osm:node/1": { p, diet } } from scripts/audit-poi-diet.mjs. */
  constructor(out, { dietChecks = {} } = {}) {
    this.out = out;
    this.dietChecks = dietChecks;
    rmSync(out, { force: true });
    mkdirSync(dirname(out), { recursive: true });
    this.db = new DatabaseSync(out);
    this.db.exec(`
      PRAGMA journal_mode = OFF; PRAGMA page_size = 4096;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE pois (
        id INTEGER PRIMARY KEY, ref TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, cell INTEGER NOT NULL,
        name TEXT NOT NULL, category TEXT NOT NULL, cuisine TEXT,
        vegan TEXT, vegetarian TEXT, gluten_free TEXT, halal TEXT, kosher TEXT,
        address TEXT, opening_hours TEXT, phone TEXT, website TEXT, description TEXT,
        approx INTEGER NOT NULL DEFAULT 0, source INTEGER NOT NULL, source_title TEXT,
        -- scripts/audit-poi-diet.mjs: how plausible the record's diet claim is (0..1), and which diet it checked.
        diet_check REAL, diet_check_for TEXT
      );
      CREATE VIRTUAL TABLE pois_fts USING fts5(name, cuisine, category, description, content='pois', content_rowid='id',
                                               tokenize='unicode61 remove_diacritics 2');
      BEGIN;
    `);
    this.ins = this.db.prepare(`INSERT INTO pois (ref, lat, lon, cell, name, category, cuisine, vegan, vegetarian, gluten_free, halal, kosher,
      address, opening_hours, phone, website, description, approx, source, source_title, diet_check, diet_check_for)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.seen = new Set();
    this.stats = { osm: 0, osmSkippedUnnamed: 0, voyage: 0, voyageApprox: 0, vegan: 0, vegetarian: 0, dietChecked: 0 };
  }

  /** An OSM element ({type, id, lat/lon or center, tags}); false when skipped (no name, duplicate). */
  addOsm(e, lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon) {
    const t = e.tags ?? {};
    const ref = `osm:${e.type}/${e.id}`;
    if (lat == null || this.seen.has(ref)) return false;
    this.seen.add(ref);
    // A place without a name can't be named in an answer.
    if (!t.name) {
      this.stats.osmSkippedUnnamed++;
      return false;
    }
    const diet = dietOf(t);
    if (diet.vegan && diet.vegan !== "no") this.stats.vegan++;
    if (diet.vegetarian && diet.vegetarian !== "no") this.stats.vegetarian++;
    const check = this.dietChecks[ref];
    this.ins.run(ref, lat, lon, cellOf(lat, lon), t.name, categoryOf(t), cuisinesOf(t).join(";") || null,
      diet.vegan ?? null, diet.vegetarian ?? null, diet.gluten_free ?? null, diet.halal ?? null, diet.kosher ?? null,
      addressOf(t), t.opening_hours ?? null, t.phone ?? t["contact:phone"] ?? null, t.website ?? t["contact:website"] ?? null,
      null, 0, 0, null, check?.p ?? null, check?.diet ?? null);
    if (check) this.stats.dietChecked++;
    this.stats.osm++;
    return true;
  }

  /** A Wikivoyage Eat/Drink listing from voyageEatDrink(). */
  addListing({ title, n, listing: l, lat, lon, exact }) {
    const description = [l.content, l.price && `Price: ${l.price}`].filter(Boolean).join(" ");
    this.ins.run(`wikivoyage:${title}#${n}`, lat, lon, cellOf(lat, lon), l.name, "listing", l.section.toLowerCase(),
      null, null, null, null, null, l.address, l.hours, l.phone, l.url, description || null, exact ? 0 : 1, 1, `${title} (${l.section})`, null, null);
    this.stats.voyage++;
    if (!exact) this.stats.voyageApprox++;
  }

  /** Indexes, writes `meta`, compacts, hashes; returns the pack's summary (also written to <out>.json). */
  async finish(meta, { placesPath, bbox } = {}) {
    const db = this.db;
    db.exec("COMMIT; CREATE INDEX pois_cell ON pois (cell); INSERT INTO pois_fts (pois_fts) VALUES ('rebuild'); INSERT INTO pois_fts (pois_fts) VALUES ('optimize');");
    // The area's biggest places (from the world gazetteer), for the catalog and the UI.
    let cities = [];
    if (placesPath && bbox) {
      const p = new DatabaseSync(placesPath, { readOnly: true });
      cities = p.prepare("SELECT name, lat, lon FROM places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY population DESC LIMIT 10")
        .all(bbox[0], bbox[2], bbox[1], bbox[3]);
      p.close();
      const near = db.prepare("SELECT COUNT(*) AS n FROM pois WHERE source = 0 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?");
      cities = cities.map((c) => ({ name: c.name, lat: c.lat, lon: c.lon, pois: near.get(c.lat - 0.05, c.lat + 0.05, c.lon - 0.05, c.lon + 0.05).n }));
    }
    const full = {
      format: "boar-poi-pack",
      formatVersion: 1,
      license: POI_LICENSE,
      poiCount: this.stats.osm + this.stats.voyage,
      cities: JSON.stringify(cities),
      builtAt: new Date().toISOString(),
      ...meta,
    };
    const setMeta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    for (const [k, v] of Object.entries(full)) setMeta.run(k, String(v));
    db.exec("VACUUM");
    db.close();
    const sha = createHash("sha256");
    await new Promise((ok, fail) => createReadStream(this.out).on("data", (d) => sha.update(d)).on("end", ok).on("error", fail));
    const summary = { id: meta.id, file: this.out, sizeBytes: statSync(this.out).size, sha256: sha.digest("hex"), osmDate: meta.osmDate, ...this.stats, cities };
    writeFileSync(`${this.out}.json`, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
}

/**
 * Eat/Drink listings of a Wikivoyage dump: { title, n, listing, lat, lon, exact }.
 * A listing without its own coordinates gets its article's {{geo}} (or its
 * parent guide's), with exact = false. `wanted(title)` limits the articles.
 */
export async function* voyageEatDrink(dumpPath, wanted = () => true) {
  const coords = new Map();
  const child = spawn("bzcat", [dumpPath], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  let buf = "";
  for await (const piece of child.stdout) {
    buf += piece;
    let end;
    while ((end = buf.indexOf("</page>")) >= 0) {
      const xml = buf.slice(buf.indexOf("<page>"), end);
      buf = buf.slice(end + 7);
      const title = xml.match(/<title>([^<]*)<\/title>/)?.[1]?.replace(/&amp;/g, "&");
      if (!title || !wanted(title)) continue;
      const page = parseDumpPage(xml);
      if (page.ns !== "0" || page.redirect) continue;
      const geo = page.text.match(/\{\{\s*geo\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)/i);
      const at = geo ? [Number(geo[1]), Number(geo[2])] : coords.get(title.split("/")[0]);
      if (geo) coords.set(title, at);
      for (const [n, listing] of voyageListings(page.text).entries()) {
        const exact = listing.lat != null;
        const lat = exact ? listing.lat : at?.[0];
        const lon = exact ? listing.lon : at?.[1];
        if (lat == null) continue;
        yield { title, n, listing, lat, lon, exact };
      }
    }
  }
}
