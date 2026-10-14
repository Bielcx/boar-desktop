#!/usr/bin/env node
// Fetches the sources of the "Ethereum and cryptography" knowledge pack into
// JSONL shards for build-wiki-pack.mjs (one document per line: page_id, title,
// text, source, url, license, aliases) plus a manifest of every document.
// Build time only; the app never runs this. See docs/KNOWLEDGE_PACKS.md.
//
//   node scripts/fetch-crypto.mjs clone <src-dir>                    # sparse clones of the git sources
//   node scripts/fetch-crypto.mjs build <src-dir> <out-dir> [shard…] # eips bips specs ethereumorg wikipedia-titles wikipedia
//   node scripts/filter-relevance.mjs --topic "…" --task crypto-relevance --report … --titles <out>/wikipedia-titles.json --out <out>/wikipedia-kept.json
//   CRYPTO_WP_TITLES=<out>/wikipedia-kept.json node scripts/fetch-crypto.mjs build <src-dir> <out-dir> wikipedia
//   node scripts/build-wiki-pack.mjs --out boar-crypto.sqlite --shards <out>/*.jsonl --manifest <out>/manifest.json
//
// Sources approved for v1.1: EIPs and ERCs, consensus/execution specs, execution
// APIs and Portal Network specs (CC0 1.0); the Yellow Paper (CC BY-SA 4.0);
// ethereum.org content (MIT); Bitcoin BIPs only under a permissive license;
// Wikipedia cryptography and blockchain categories (CC BY-SA 4.0), vetted by
// filter-relevance. Not included: Solidity docs (GPL), Mastering Ethereum and
// Mastering Bitcoin (NC/ND).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { bipDoc, cleanMarkdown, eipDoc, frontMatter, latexSections } from "./lib/crypto-lib.mjs";
import { categoryPages, wikiText, wikitexts } from "./lib/mediawiki.mjs";

const CC0 = "CC0 1.0";
const BY_SA = "CC BY-SA 4.0";
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// name → [GitHub repo, sparse-checkout patterns]
const REPOS = {
  EIPs: ["ethereum/EIPs", ["/EIPS/*.md", "/LICENSE*"]],
  ERCs: ["ethereum/ERCs", ["/ERCS/*.md", "/LICENSE*"]],
  "consensus-specs": ["ethereum/consensus-specs", ["/specs/**/*.md", "/LICENSE*"]],
  "execution-specs": ["ethereum/execution-specs", ["/docs/**/*.md", "/LICENSE*"]],
  "execution-apis": ["ethereum/execution-apis", ["/docs-api/**/*.md", "/LICENSE*"]],
  "portal-network-specs": ["ethereum/portal-network-specs", ["/**/*.md", "/LICENSE*"]],
  yellowpaper: ["ethereum/yellowpaper", ["/Paper.tex", "/README.md"]],
  "ethereum-org-website": ["ethereum/ethereum-org-website", ["/public/content/**/index.md", "!/public/content/translations/", "/LICENSE*"]],
  bips: ["bitcoin/bips", ["/bip-*.mediawiki", "/bip-*.md", "/LICENSE*"]],
};

const [mode, src, out, ...only] = process.argv.slice(2);
if (!src || !["clone", "build"].includes(mode)) throw new Error("usage: fetch-crypto.mjs clone <src-dir> | build <src-dir> <out-dir> [shard…]");

if (mode === "clone") {
  mkdirSync(src, { recursive: true });
  for (const [name, [repo, patterns]] of Object.entries(REPOS)) {
    const dir = join(src, name);
    if (!existsSync(dir)) {
      execFileSync("git", ["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", `https://github.com/${repo}`, dir], { stdio: "inherit" });
      execFileSync("git", ["-C", dir, "sparse-checkout", "set", "--no-cone", ...patterns], { stdio: "inherit" });
    }
    log(`${name} @ ${head(name)}`);
  }
  process.exit(0);
}

function head(name) {
  return execFileSync("git", ["-C", join(src, name), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
const blob = (name, file) => `https://github.com/${REPOS[name][0]}/blob/${head(name)}/${relative(join(src, name), file)}`;

function* walk(dir, pattern) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, pattern);
    else if (pattern.test(e.name)) yield p;
  }
}

mkdirSync(out, { recursive: true });
const manifest = existsSync(join(out, "manifest.json")) ? JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) : [];
const which = new Set(only);
// Each shard rewrites its own JSONL and its own manifest rows, so one source can be fetched again on its own.
const want = (s) => {
  if (which.size && !which.has(s)) return false;
  rmSync(join(out, `${s}.jsonl`), { force: true });
  for (let i = manifest.length - 1; i >= 0; i--) if (manifest[i].shard === s) manifest.splice(i, 1);
  return true;
};
function emit(shard, doc, minChars = 300) {
  if (doc.text.length < minChars) return false;
  appendFileSync(join(out, `${shard}.jsonl`), `${JSON.stringify(doc)}\n`);
  manifest.push({ shard, source: doc.source, title: doc.title, url: doc.url, license: doc.license, chars: doc.text.length });
  return true;
}

// ---- EIPs and ERCs (source "eips", ids 5e9 + number) ----
if (want("eips")) {
  // A number in both repositories (a moved ERC left as a stub in EIPs) keeps the longer text.
  const byNumber = new Map();
  for (const repo of ["EIPs", "ERCs"]) {
    for (const f of walk(join(src, repo, repo.toUpperCase()), /^e(ip|rc)-\d+\.md$/)) {
      const d = eipDoc(readFileSync(f, "utf8"), { repo });
      if (d && (byNumber.get(d.number)?.text.length ?? 0) < d.text.length) byNumber.set(d.number, d);
    }
  }
  let n = 0;
  for (const d of [...byNumber.values()].sort((a, b) => a.number - b.number)) {
    if (emit("eips", { page_id: 5e9 + d.number, title: d.title, text: d.text, source: "eips", url: d.url, license: CC0, aliases: d.aliases })) n++;
  }
  log(`eips: ${n} documents of ${byNumber.size}`);
}

// ---- Bitcoin BIPs (source "bips", ids 8e9 + number) ----
if (want("bips")) {
  let n = 0;
  let skipped = 0;
  for (const f of walk(join(src, "bips"), /^bip-\d+\.(mediawiki|md)$/)) {
    const d = bipDoc(readFileSync(f, "utf8"), { file: f });
    if (!d) {
      skipped++;
      continue;
    }
    if (emit("bips", { page_id: 8e9 + d.number, title: d.title, text: d.text, source: "bips", url: blob("bips", f), license: d.license, aliases: d.aliases })) n++;
  }
  log(`bips: ${n} documents (${skipped} without a permissive license header, left out)`);
}

// ---- Specs and the Yellow Paper (source "ethspecs", ids 6e9 + i) ----
if (want("specs")) {
  let i = 0;
  const add = (doc) => emit("specs", { page_id: 6e9 + i++, source: "ethspecs", ...doc });
  const firstHeading = (md) => md.match(/^# (.+)$/m)?.[1].trim();
  const specFiles = [
    ["consensus-specs", "specs", (rel) => `Consensus specs${rel.includes("/") ? ` (${rel.split("/")[0].replace(/^_/, "")})` : ""}`, null],
    // execution-specs' docs are mostly about its own test tooling: only the overview pages.
    ["execution-specs", "docs", () => "Execution specs", /(^|\/)(dev|filling_tests|running_tests|library|getting_started|consensus_tests|writing_tests|templates|navigation\.md)/],
    ["execution-apis", "docs-api", () => "Execution APIs", /contributors-guide|tests\.md/],
    ["portal-network-specs", ".", () => "Portal Network", /test-vectors|TEMPLATE|template\.md|bootnodes/],
  ];
  const counts = {};
  for (const [repo, dir, prefix, skip] of specFiles) {
    const root = join(src, repo, dir);
    counts[repo] = 0;
    for (const f of walk(root, /\.md$/)) {
      const rel = relative(root, f);
      if (skip?.test(rel)) continue;
      const md = readFileSync(f, "utf8");
      const [, body] = frontMatter(md);
      const h1 = firstHeading(body) ?? rel.replace(/\.md$/, "");
      const title = `${prefix(rel)}: ${h1}`;
      const text = `# ${title}\n\n${cleanMarkdown(body.replace(/^# .+$/m, ""))}`;
      if (add({ title, text, url: blob(repo, f), license: CC0 })) counts[repo]++;
    }
  }
  const paper = join(src, "yellowpaper", "Paper.tex");
  counts.yellowpaper = 0;
  for (const s of latexSections(readFileSync(paper, "utf8"))) {
    const title = `Ethereum Yellow Paper: ${s.title}`;
    if (add({ title, text: s.text.replace(/^# .*/, `# ${title}`), url: blob("yellowpaper", paper), license: BY_SA })) counts.yellowpaper++;
  }
  log(`specs: ${JSON.stringify(counts)}`);
}

// ---- ethereum.org (source "ethereumorg", ids 7e9 + i) ----
if (want("ethereumorg")) {
  const root = join(src, "ethereum-org-website", "public", "content");
  // Site furniture, not reference material.
  const SKIP = /^(translations|videos|contributing|community|stories|latest|foundation|about|terms-of-use|privacy-policy|cookie-policy|assets)(\/|$)/;
  let i = 0;
  let n = 0;
  for (const f of walk(root, /^index\.md$/)) {
    const rel = relative(root, f).replace(/\/?index\.md$/, "");
    if (SKIP.test(rel)) continue;
    const [fm, body] = frontMatter(readFileSync(f, "utf8"));
    if (fm.lang && fm.lang !== "en") continue;
    const title = fm.title || rel.split("/").pop();
    const lead = fm.description ? `${fm.description}\n\n` : "";
    const text = `# ${title}\n\n${lead}${cleanMarkdown(body)}`;
    if (emit("ethereumorg", { page_id: 7e9 + i++, title, text, source: "ethereumorg", url: `https://ethereum.org/${rel ? `${rel}/` : ""}`, license: "MIT" })) n++;
  }
  log(`ethereumorg: ${n} pages`);
}

// ---- Wikipedia (source "enwiki"): category crawl, then only the titles filter-relevance kept ----
const WP_API = "https://en.wikipedia.org/w/api.php";
const WP_ROOTS = [
  "Cryptography", "Cryptographic algorithms", "Cryptographic hash functions", "Digital signature schemes",
  "Elliptic curve cryptography", "Post-quantum cryptography", "Zero-knowledge proofs", "Cryptographic protocols",
  "Blockchains", "Ethereum", "Cryptocurrencies", "Smart contracts", "Decentralized finance",
];
// Standardized post-quantum schemes the category crawl misses (checked by name only; redirects followed, missing skipped).
const WP_EXTRA = ["ML-DSA", "CRYSTALS-Dilithium", "Kyber", "ML-KEM", "SLH-DSA", "Falcon (signature scheme)", "HQC (cryptography)"];
if (which.has("wikipedia-titles")) {
  const titles = await categoryPages(WP_API, WP_ROOTS, Number(process.env.CRYPTO_WP_DEPTH ?? 1));
  writeFileSync(join(out, "wikipedia-titles.json"), JSON.stringify(titles));
  log(`wikipedia: ${titles.length} candidate titles → ${join(out, "wikipedia-titles.json")}`);
}
if (which.has("wikipedia") && want("wikipedia")) {
  const file = process.env.CRYPTO_WP_TITLES;
  if (!file) throw new Error("CRYPTO_WP_TITLES: the titles filter-relevance kept");
  const seen = new Map(); // page id → its manifest-bound document, so a later redirect to it still adds an alias
  let n = 0;
  const titles = [...JSON.parse(readFileSync(file, "utf8")), ...WP_EXTRA];
  const docs = [];
  for await (const p of wikitexts(WP_API, titles)) {
    const known = seen.get(p.id);
    if (known) {
      known.aliases = [...new Set([...known.aliases, ...p.aliases])];
      continue;
    }
    const doc = { page_id: p.id, title: p.title, text: wikiText(p.title, p.wikitext), source: "enwiki", url: p.url, license: BY_SA, revid: p.revid, aliases: p.aliases };
    seen.set(p.id, doc);
    docs.push(doc);
  }
  for (const doc of docs) if (emit("wikipedia", doc)) n++;
  log(`wikipedia: ${n} articles`);
}

writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
const bytes = readdirSync(out).filter((f) => f.endsWith(".jsonl")).reduce((s, f) => s + statSync(join(out, f)).size, 0);
log(`manifest: ${manifest.length} documents, ${(bytes / 1e6).toFixed(1)} MB of JSONL`);
