#!/usr/bin/env node
// Draws cities for extra places packs at random, reproducibly, so the "any
// city" claim is tested on cities nobody picked: GeoNames cities15000 with a
// population of at least --min-pop, minus --exclude ids, sorted by GeoNames id,
// shuffled (Fisher-Yates, mulberry32 PRNG) with a fixed --seed; the first --n
// win. Prints one JSON object per city with a bounding box of --radius-km.
//
//   node scripts/draw-poi-cities.mjs --cities cities15000.txt --seed 20261003 --n 5 \
//     --exclude sao-paulo,singapore,taipei,buenos-aires,berlin
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    cities: { type: "string" },
    seed: { type: "string", default: "20261003" },
    n: { type: "string", default: "5" },
    "min-pop": { type: "string", default: "1000000" },
    exclude: { type: "string", default: "" },
    "radius-km": { type: "string", default: "20" },
  },
});
if (!o.cities) throw new Error("--cities cities15000.txt is required");

export const slug = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const exclude = new Set(o.exclude.split(",").filter(Boolean));
const pool = readFileSync(o.cities, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"))
  .map((c) => ({ geonameid: Number(c[0]), name: c[1], ascii: c[2], lat: Number(c[4]), lon: Number(c[5]), country: c[8], population: Number(c[14]), tz: c[17] }))
  .filter((c) => c.population >= Number(o["min-pop"]) && !exclude.has(slug(c.ascii)))
  .sort((a, b) => a.geonameid - b.geonameid);
const rand = mulberry32(Number(o.seed));
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const r = Number(o["radius-km"]);
for (const c of pool.slice(0, Number(o.n))) {
  const dLat = r / 111.195;
  const dLon = dLat / Math.cos((c.lat * Math.PI) / 180);
  const f = (x) => x.toFixed(2);
  const bbox = [f(c.lat - dLat), f(c.lon - dLon), f(c.lat + dLat), f(c.lon + dLon)].join(",");
  console.log(JSON.stringify({ id: slug(c.ascii), ...c, bbox, poolSize: pool.length }));
}
