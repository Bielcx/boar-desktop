#!/usr/bin/env node
// Diet audit for places packs: for every OSM place whose tags claim a diet
// (diet:vegan=only/yes, cuisine=vegan, or diet:vegetarian=only), asks Jev how
// plausible that claim is from the place's own record (name, category,
// cuisine, brand, operator). OSM data is never changed: the probability is
// stored next to it (build-poi-pack.mjs --diet-check) and the app ranks
// doubtful claims last with an "OSM tag to verify" mark.
//
//   node scripts/audit-poi-diet.mjs --out diet-check.json osm-sao-paulo.json osm-berlin.json ...
//   node scripts/audit-poi-diet.mjs --out diet-check-world.json work/extracts/*.jsonl.gz
//
// Build-time only (Jev via the Vercel AI Gateway, VERCEL_AI_GATEWAY); cached,
// cost logged, budget-capped (see scripts/lib/jev.mjs).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { booleanPerItem, spentUsd } from "./lib/jev.mjs";
import { cuisinesOf, dietOf } from "./lib/poi-pack-lib.mjs";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, budget: { type: "string", default: "1.5" }, limit: { type: "string", default: "0" } },
});
if (!o.out || !positionals.length) throw new Error("usage: audit-poi-diet.mjs --out FILE osm.json...");
const TASK = "poi-diet-audit";

const QUESTION = {
  "vegan:only": "Is it plausible that this place serves only vegan food (a fully vegan menu, no meat, fish, dairy or eggs)?",
  "vegan:yes": "Is it plausible that this place offers vegan dishes on its menu?",
  "vegetarian:only": "Is it plausible that this place serves only vegetarian food (no meat or fish at all)?",
};

/** The strongest diet claim a record makes, or null: vegan first, then vegetarian only. */
export function claimOf(tags) {
  const d = dietOf(tags);
  if (d.vegan === "only" || d.vegan === "yes") return { diet: "vegan", level: d.vegan };
  if (d.vegetarian === "only") return { diet: "vegetarian", level: "only" };
  return null;
}

/** Elements of an Overpass JSON file, or of a build-poi-world.mjs extract (.jsonl.gz, one element per line). */
function* elementsOf(file) {
  if (file.endsWith(".jsonl.gz")) {
    for (const line of gunzipSync(readFileSync(file)).toString("utf8").split("\n")) if (line) yield JSON.parse(line);
  } else {
    yield* JSON.parse(readFileSync(file, "utf8")).elements ?? [];
  }
}

const items = new Map();
for (const file of positionals) {
  for (const e of elementsOf(file)) {
    const t = e.tags ?? {};
    const claim = t.name ? claimOf(t) : null;
    if (!claim) continue;
    const ref = `osm:${e.type}/${e.id}`;
    const record = {
      name: t.name,
      category: t.amenity ?? t.shop,
      ...(cuisinesOf(t).length ? { cuisine: cuisinesOf(t).join(", ") } : {}),
      ...(t.brand ? { brand: t.brand } : {}),
      ...(t.operator ? { operator: t.operator } : {}),
      ...(t["name:en"] && t["name:en"] !== t.name ? { name_en: t["name:en"] } : {}),
      [`diet:${claim.diet}`]: claim.level,
    };
    // Question keys: the OSM ref with characters Jev keys accept.
    items.set(ref.replace(/[^a-z0-9]/gi, "_"), { ref, claim, record });
  }
}
let keys = [...items.keys()];
if (Number(o.limit)) keys = keys.slice(0, Number(o.limit));
console.log(`${keys.length} places with a diet claim`);

const result = existsSync(o.out) ? JSON.parse(readFileSync(o.out, "utf8")) : {};
const todo = new Map(keys.filter((k) => !(items.get(k).ref in result)).map((k) => [k, items.get(k)]));
const probs = await booleanPerItem(todo, (it) => `${QUESTION[`${it.claim.diet}:${it.claim.level}`]} Place: ${JSON.stringify(it.record)}`, {
  task: TASK,
  budgetUsd: Number(o.budget),
  size: 25,
  onBatch: (done, total) => {
    if (done % 500 < 25 || done === total) console.log(`${done}/${total}, spent US$${spentUsd(TASK).toFixed(4)}`);
  },
});
for (const [k, p] of probs) {
  const it = items.get(k);
  if (p != null) result[it.ref] = { p, diet: it.claim.diet, level: it.claim.level, name: it.record.name };
}
writeFileSync(o.out, `${JSON.stringify(result, null, 1)}\n`);
console.log(`wrote ${Object.keys(result).length} checks to ${o.out}; task spend US$${spentUsd(TASK).toFixed(4)}`);
