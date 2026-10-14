#!/usr/bin/env node
// Checks every hosted asset against its host: the pinned URL must resolve,
// and the host-reported size (and sha256, where the host exposes it) must
// match the catalog. Needs network; not part of `npm test`.
//
//   node scripts/verify-manifest-pins.mjs [--strict] [file.ts ...]
//
// Default files: src/models/manifest.ts, plus src/rag/poiRegions.ts (places
// packs, world gazetteer), src/rag/preparedness.ts, src/rag/cryptoPack.ts and
// src/rag/wikiEnPacks.ts when they exist. Hugging Face files are checked
// through the Hub API (size + LFS sha256), never downloaded when large. Entries with an empty
// sourceUrl are import-only; they are listed, and fail only with --strict
// (use it once the packs are hosted).
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const DEFAULT_FILES = ["src/models/manifest.ts", "src/rag/poiRegions.ts", "src/rag/preparedness.ts", "src/rag/cryptoPack.ts", "src/rag/wikiEnPacks.ts"];
const files = args.filter((a) => a !== "--strict");
const root = new URL("../", import.meta.url);
const targets = files.length ? files : DEFAULT_FILES.filter((f) => existsSync(new URL(f, root)));

// One match per catalog object: sizeBytes, sha256 and sourceUrl in that order
// (a few string fields or comments may sit between sha256 and sourceUrl),
// labelled with the nearest id (or filename) before or after it.
const ENTRY = /sizeBytes:\s*(\d+),\s*sha256:\s*"([0-9a-f]{64})",(?:\s*(?:\w+:\s*"[^"]*",|\/\*[\s\S]*?\*\/|\/\/[^\n]*)){0,4}\s*sourceUrl:\s*"([^"]*)"/g;
const entries = [];
for (const file of targets) {
  const src = readFileSync(new URL(file, root), "utf8");
  for (let m; (m = ENTRY.exec(src)); ) {
    const before = [...src.slice(0, m.index).matchAll(/\b(?:id:\s*"([^"]+)"|part:\s*(\d+))/g)].pop();
    const after = /filename:\s*"([^"]+)"/.exec(src.slice(m.index, m.index + 400));
    const inObject = before && !src.slice(before.index, m.index).includes("},");
    const fileBefore = [...src.slice(Math.max(0, m.index - 400), m.index).matchAll(/filename:\s*"([^"]+)"/g)].pop();
    entries.push({ id: inObject ? before[1] ?? `${file.split("/").pop()} part ${before[2]}` : after?.[1] ?? fileBefore?.[1] ?? `${file}@${m.index}`, filename: after?.[1] ?? fileBefore?.[1], size: Number(m[1]), sha256: m[2], url: m[3] });
  }
}

const HF = /^https:\/\/huggingface\.co\/(datasets\/)?([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/;
const SMALL_FILE_BYTES = 16 * 1024 * 1024;

// The host rate-limits bursts (HTTP 429): wait and retry instead of failing the entry.
async function fetchRetry(url, init, attempts = 4) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, init);
    if (i >= attempts || (res.status !== 429 && res.status < 500)) return res;
    const wait = Number(res.headers.get("retry-after")) || 2 ** i;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
  }
}

async function check(e) {
  const hf = HF.exec(e.url);
  if (hf) {
    const [, dataset, repo, rev, path] = hf;
    const res = await fetchRetry(`https://huggingface.co/api/${dataset ? "datasets" : "models"}/${repo}/paths-info/${rev}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ paths: path }),
    });
    if (!res.ok) return `paths-info HTTP ${res.status}`;
    const [info] = await res.json();
    if (!info) return "file not found at pinned revision";
    if (info.size !== e.size) return `size ${info.size} != manifest ${e.size}`;
    // Small files may live in git, not LFS: then the host has no sha256 and we hash the bytes.
    // Never download a big one just to hash it (the wiki shards are ~1.2 GB each).
    if (!info.lfs) return e.size <= SMALL_FILE_BYTES ? hashDownload(e) : "not in LFS: host has no sha256 (not downloaded)";
    if (info.lfs.oid !== e.sha256) return `sha256 ${info.lfs.oid} != manifest ${e.sha256}`;
    return null;
  }
  if (e.size <= SMALL_FILE_BYTES) return hashDownload(e);
  // Large non-HF asset (release download): size only, to avoid a big download.
  const res = await fetchRetry(e.url, { method: "HEAD", redirect: "follow" });
  if (!res.ok) return `HTTP ${res.status}`;
  const len = Number(res.headers.get("content-length"));
  return len === e.size ? null : `size ${len} != manifest ${e.size} (sha256 not checked)`;
}

async function hashDownload(e) {
  const res = await fetchRetry(e.url);
  if (!res.ok) return `HTTP ${res.status}`;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== e.size) return `size ${buf.length} != manifest ${e.size}`;
  const digest = createHash("sha256").update(buf).digest("hex");
  return digest === e.sha256 ? null : `sha256 ${digest} != manifest ${e.sha256}`;
}

// Places packs are useless without the world gazetteer (PL-1): the catalog must
// have it (hosted, with --strict) and every places-pack entry must require it.
const GAZETTEER_FILE = "poi/world-places.sqlite";
const GAZETTEER_ID = "poi-world-places";
const placeProblems = [];
const placesPacks = entries.filter((e) => e.filename?.startsWith("poi/") && e.filename !== GAZETTEER_FILE);
const gazetteer = entries.find((e) => e.filename === GAZETTEER_FILE);
if (placesPacks.length && !gazetteer) placeProblems.push(`${placesPacks.length} places pack(s) but no ${GAZETTEER_FILE} in the catalog`);
if (placesPacks.length && gazetteer && !gazetteer.url && strict) placeProblems.push(`${GAZETTEER_FILE} is not hosted`);
for (const file of targets) {
  const src = readFileSync(new URL(file, root), "utf8");
  // The gazetteer id, written as the string or as a constant declared in the file (WORLD_PLACES_ID).
  const names = [`"${GAZETTEER_ID}"`, ...[...src.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*"${GAZETTEER_ID}"`, "g"))].map((c) => c[1])];
  const mentions = (text) => names.some((n) => new RegExp(n.startsWith('"') ? n : `\\b${n}\\b`).test(text));
  for (const m of src.matchAll(/format:\s*"poi-pack"/g)) {
    // The object literal around this entry: from the nearest "{" before it to the next closing "}" at its level.
    const start = src.lastIndexOf("{", m.index);
    const end = src.indexOf("\n  }", m.index);
    const obj = src.slice(start, end < 0 ? m.index + 600 : end);
    const isGazetteer = /id:\s*([^,\n]+)/.test(obj) && mentions(/id:\s*([^,\n]+)/.exec(obj)[1]);
    const requiresIt = /requires:\s*\[([^\]]*)\]/.test(obj) && mentions(/requires:\s*\[([^\]]*)\]/.exec(obj)[1]);
    if (!isGazetteer && !requiresIt && !/filename:\s*"poi\/world-places\.sqlite"/.test(obj)) {
      placeProblems.push(`${file.split("/").pop()}: a places-pack entry doesn't require ${GAZETTEER_ID}`);
    }
  }
}
for (const p of placeProblems) console.log(`FAIL places — ${p}`);

let failed = placeProblems.length;
let unhosted = 0;
let ok = 0;
for (const e of entries) {
  if (!e.url) {
    unhosted++;
    console.log(`${strict ? "FAIL" : "--  "} ${e.id} — not hosted (import-only)`);
    if (strict) failed++;
    continue;
  }
  const err = await check(e).catch((x) => String(x));
  console.log(`${err ? "FAIL" : "ok  "} ${e.id}${err ? ` — ${err}` : ""}`);
  if (err) failed++;
  else ok++;
}
console.log(`${entries.length} entries from ${targets.join(", ")}: ${ok} ok, ${failed} failed, ${unhosted} not hosted`);
if (entries.length === 0) {
  console.error("No catalog entries parsed");
  process.exit(2);
}
process.exit(failed ? 1 : 0);
