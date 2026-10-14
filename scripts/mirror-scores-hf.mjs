#!/usr/bin/env node
// Copies BOAR's public scores to a Hugging Face dataset (scores.csv, scores.jsonl, README.md).
// Reads with the publishable key only, so it sees exactly what the public already sees: approved
// eval_scores rows. Commits only when the files changed.
//
//   SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… HF_TOKEN=… HF_DATASET=<owner>/<name> \
//     node scripts/mirror-scores-hf.mjs [--dry-run] [--out <dir>]
//
// --dry-run writes the files to --out (default build/hf-mirror) and doesn't touch the Hub.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitBody, datasetCard, scoresPageUrl, toCsv, toJsonl } from "./lib/hf-mirror-lib.mjs";

const PAGE = 1000;
// Plain (non-LFS) files; past this the Hub wants LFS, which this script doesn't do yet.
const MAX_FILE_BYTES = 9_000_000;
const SOURCE_REPO = "rferrari/boar-app";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : "build/hf-mirror";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return v;
}

const supabaseUrl = need("SUPABASE_URL");
const key = need("SUPABASE_PUBLISHABLE_KEY");

async function fetchScores() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(scoresPageUrl(supabaseUrl, offset, PAGE), { headers: { apikey: key }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`eval_scores: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const rows = await fetchScores();
const files = {
  "scores.csv": toCsv(rows),
  "scores.jsonl": toJsonl(rows),
  "README.md": datasetCard({ rows, sourceRepo: SOURCE_REPO }),
};
for (const [path, content] of Object.entries(files)) {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`${path} is over ${MAX_FILE_BYTES} bytes: add LFS upload`);
}
console.log(`${rows.length} public score rows`);

if (dryRun) {
  mkdirSync(outDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(outDir, path), content);
  console.log(`wrote ${Object.keys(files).join(", ")} to ${outDir}`);
  process.exit(0);
}

const token = need("HF_TOKEN");
const dataset = need("HF_DATASET");
const auth = { authorization: `Bearer ${token}` };

// Skip files the dataset already has, so a quiet day makes no commit.
const changed = {};
for (const [path, content] of Object.entries(files)) {
  const res = await fetch(`https://huggingface.co/datasets/${dataset}/resolve/main/${path}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
  if (res.ok && (await res.text()) === content) continue;
  if (!res.ok && res.status !== 404) throw new Error(`${path}: HTTP ${res.status}`);
  changed[path] = content;
}
if (Object.keys(changed).length === 0) {
  console.log("no change");
  process.exit(0);
}

const res = await fetch(`https://huggingface.co/api/datasets/${dataset}/commit/main`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/x-ndjson" },
  signal: AbortSignal.timeout(60_000),
  body: commitBody(`Update scores (${rows.length} rows)`, changed),
});
if (!res.ok) throw new Error(`commit: HTTP ${res.status} ${await res.text()}`);
console.log(`committed ${Object.keys(changed).join(", ")} to ${dataset}`);
