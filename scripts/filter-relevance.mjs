#!/usr/bin/env node
// Relevance filter for topic packs: one Jev yes/no per candidate document
// (title + the start of its text), kept at >= --cut (default 0.5). Writes the
// kept documents and a report of what was dropped, with probabilities, so the
// pack's report can list them. Build time only (scripts/lib/jev.mjs: cached,
// cost logged, budget-capped).
//
//   # JSONL shards (documents already fetched): writes <shard>.kept.jsonl next to each
//   node scripts/filter-relevance.mjs --topic "..." --task prep-relevance --report report.json appropedia.jsonl
//   # a list of Wikipedia titles: fetches each lead first, writes the kept titles
//   node scripts/filter-relevance.mjs --topic "..." --task prep-relevance --report report.json --titles titles.json --out kept.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { booleanPerItem, spentUsd } from "./lib/jev.mjs";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    topic: { type: "string" },
    task: { type: "string" },
    budget: { type: "string", default: "0.15" },
    cut: { type: "string", default: "0.5" },
    report: { type: "string" },
    titles: { type: "string" },
    out: { type: "string" },
    api: { type: "string", default: "https://en.wikipedia.org/w/api.php" },
    // Appropedia keeps translations as subpages ("Growing tomatoes/fa"): English only, dropped without asking.
    "drop-translations": { type: "boolean", default: false },
  },
});
if (!o.topic || !o.task || !o.report) throw new Error("--topic, --task and --report are required");
const cut = Number(o.cut);
const UA = "BOAR-pack-builder/0.1 (https://github.com/rferrari/boar-app)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lead = (text) => text.replace(/^# [^\n]*\n+/, "").replace(/\s+/g, " ").slice(0, 600);

export const question = (topic, doc) =>
  `Is this document useful reference material for an offline knowledge pack about ${topic}? ` +
  `Yes if it explains a concept, skill, technique, hazard, tool, material or practice within that topic. ` +
  `No if it is mainly about a person, company, product brand, organization, work of fiction, sports team, ` +
  `a specific historical event or a place, or if the topic is only mentioned in passing. ` +
  `Document: ${JSON.stringify({ title: doc.title, beginning: doc.lead })}`;

async function wikiLeads(titles) {
  const cache = `${o.titles}.leads.json`;
  const leads = existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : {};
  const todo = titles.filter((t) => !(t in leads));
  for (let i = 0; i < todo.length; i += 20) {
    const q = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", prop: "extracts", exintro: "1", explaintext: "1",
      exchars: "600", exlimit: "20", redirects: "1", titles: todo.slice(i, i + 20).join("|"),
    });
    for (let attempt = 0; ; attempt++) {
      const body = await (await fetch(`${o.api}?${q}`, { headers: { "User-Agent": UA } })).text();
      if (body.startsWith("{")) {
        const j = JSON.parse(body);
        const back = new Map((j.query.redirects ?? []).map((r) => [r.to, r.from]));
        for (const p of j.query.pages ?? []) leads[back.get(p.title) ?? p.title] = p.extract ?? "";
        break;
      }
      if (attempt > 5) throw new Error(body.slice(0, 100));
      await sleep(5000 * 2 ** attempt);
    }
    if (i % 1000 === 0) {
      writeFileSync(cache, JSON.stringify(leads));
      console.log(`leads ${i}/${todo.length}`);
    }
    await sleep(700);
  }
  writeFileSync(cache, JSON.stringify(leads));
  return leads;
}

const docs = new Map(); // key → { title, lead, ref }
if (o.titles) {
  const titles = JSON.parse(readFileSync(o.titles, "utf8"));
  const leads = await wikiLeads(titles);
  titles.forEach((t, i) => docs.set(`d${i}`, { title: t, lead: (leads[t] ?? "").replace(/\s+/g, " ").slice(0, 600), ref: t }));
} else {
  for (const file of positionals) {
    readFileSync(file, "utf8").split("\n").filter(Boolean).forEach((l, i) => {
      const d = JSON.parse(l);
      docs.set(`${file.replace(/\W+/g, "_").slice(-20)}_${i}`, { title: d.title, lead: lead(d.text), ref: { file, line: l } });
    });
  }
}
const translations = [];
if (o["drop-translations"]) {
  for (const [k, d] of docs) {
    if (/\/[a-z]{2,3}(-[a-z]{2,4})?$/.test(d.title)) (translations.push(d.title), docs.delete(k));
  }
}
console.log(`${docs.size} candidates${translations.length ? ` (${translations.length} translations dropped)` : ""}`);
const probs = await booleanPerItem(docs, (d) => question(o.topic, d), {
  task: o.task,
  budgetUsd: Number(o.budget),
  size: 25,
  onBatch: (done, total) => done % 1000 < 25 && console.log(`${done}/${total}, spent US$${spentUsd(o.task).toFixed(4)}`),
});

const kept = [];
const dropped = [];
for (const [k, d] of docs) {
  const p = probs.get(k);
  (p != null && p >= cut ? kept : dropped).push({ title: d.title, p, ref: d.ref });
}
if (o.titles) {
  writeFileSync(o.out, JSON.stringify(kept.map((d) => d.title)));
} else {
  for (const file of positionals) {
    const lines = kept.filter((d) => d.ref.file === file).map((d) => d.ref.line);
    writeFileSync(file.replace(/\.jsonl$/, ".kept.jsonl"), lines.length ? `${lines.join("\n")}\n` : "");
  }
}
const report = existsSync(o.report) ? JSON.parse(readFileSync(o.report, "utf8")) : {};
report[o.titles ?? positionals.join(",")] = {
  topic: o.topic,
  cut,
  candidates: docs.size + translations.length,
  translationsDropped: translations.length,
  kept: kept.length,
  dropped: dropped.sort((a, b) => (a.p ?? 0) - (b.p ?? 0)).map((d) => ({ title: d.title, p: d.p })),
  spentUsd: spentUsd(o.task),
};
writeFileSync(o.report, `${JSON.stringify(report, null, 1)}\n`);
console.log(`kept ${kept.length} of ${docs.size}; task spend US$${spentUsd(o.task).toFixed(4)}`);
