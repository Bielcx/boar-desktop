#!/usr/bin/env node
// Builds a large offline knowledge pack (format 2): full Wikipedia articles for
// the most-read pages and lead sections for the rest, from FineWiki parquet
// shards, plus Wikivoyage, redirects and embeddings of each article's lead.
// See docs/KNOWLEDGE_PACKS.md ("Large packs"). Needs Node >= 23.8 (zstd in node:zlib).
//
//   node scripts/build-wiki-pack.mjs --out pack.sqlite \
//     --shards /data/finewiki/000_00007.parquet [more shards...] \
//     --pageviews pageviews-en.tsv --full-top 1000000 \
//     --redirects enwiki-latest-redirect.sql.gz --index enwiki-latest-pages-articles-multistream-index.txt.bz2 \
//     --wikivoyage enwikivoyage-latest-pages-articles.xml.bz2
//
// Pack layout (one SQLite file, opened read-only by src/rag/wikiPack.ts):
//   meta(key, value)                       format, sources, build parameters, embedding model
//   blocks(id, zdata)                      zstd-compressed runs of article text (UTF-8)
//   articles(id, source, page_id, title, views, block_id, off, len)   off/len: bytes in the block
//   chunks(id, article_id, start, end)     UTF-16 offsets into the article text
//   fts(title, section, body)              contentless FTS5, rowid = chunks.id
//   redirects(title, article_id)           alternative titles → article
//   df(term, doc)                          document counts of common index terms (query-time idf)
//   lead_vecs(article_id, scale, vec)      int8 embedding of the article's lead chunk
//   article_meta(article_id, url, license) optional: per-article source URL and license (multi-source packs)
//
// The approach (tiering by pageviews, contentless index over compressed blocks,
// redirect table) follows AndroidLM's scripts/build_corpus.py and
// build_redirects.py (https://github.com/Phineas1500/AndroidLM, Apache-2.0).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { constants as zc, createGunzip, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { parseArgs } from "node:util";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { chunkArticle, cleanWikivoyage, infoboxText, isTable, leadChunkIndex, leadOf, parseDumpPage, parseIndexLine, parseRedirectRows, normalizeUrl } from "./lib/wiki-pack-lib.mjs";
import { quantizeInt8 } from "./lib/knowledge-pack-lib.mjs";
import { EMBEDDING_MODEL, embedChunks, ensureEmbeddingModel, sha256File } from "./lib/embedding.mjs";

const USAGE = `usage: node scripts/build-wiki-pack.mjs --out FILE --shards A.parquet [B.parquet ...] [options]

  --out FILE              pack to write (replaced if it exists)
  --shards FILES...       FineWiki parquet shards (data/enwiki/*.parquet), processed in order;
                          a .jsonl file with {page_id, title, text} per line also works (test fixtures)
  --pageviews TSV         page_id<TAB>views; ranks articles for --full-top and the popularity signal
  --pageview-days N       days the pageviews TSV covers (views are scaled to a month), default 30
  --full-top N            articles kept in full, by views (others keep their lead), default 1000000
  --lead-chars N          lead size cap for the other articles, default 2500
  --chunk-chars N         target chunk size, default 1000
  --redirects SQL.GZ      enwiki-*-redirect.sql.gz        (with --index)
  --index TXT.BZ2         enwiki-*-pages-articles-multistream-index.txt.bz2
  --wikivoyage XML.BZ2    enwikivoyage-*-pages-articles.xml.bz2
  --no-embed              skip lead embeddings
  --embed-only            only add lead embeddings and metadata to an existing --out pack
                          (resumes a build that stopped after its text and index were written)
  --embed-threads N       parallel embedding contexts, default 8
  --embed-top N           embed only the N most-viewed Wikipedia articles' leads (plus every Wikivoyage guide);
                          default 0 = all
  --limit N               stop after N Wikipedia articles (a quick test build)
  --delete-shards         delete each shard once it's in the pack (keeps peak disk use down);
                          shards given as URLs are always downloaded to --work-dir and deleted
  --work-dir DIR          where URL shards are downloaded, default next to --out
  --min-free-gb N         pause (and log PAUSED) while free disk is under N GB, default 0
  --wait-for-shards       don't download URL shards: wait for them to appear in --work-dir (scripts/fetch-shards.sh)
  --manifest FILE         topic packs: JSON list of {source, title, url, license} (meta gets per-source counts)
  --name TEXT             the pack's display name, stored in meta
  --no-optimize           skip the final FTS 'optimize' merge (it needs free space about the index's size)
  --block-kb N            uncompressed text per compressed block, default 64
  --zlevel N              zstd level, default 12`;

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
// Source codes stored in articles.source (the app maps them back in src/rag/wikiPack.ts).
const SOURCE = { enwiki: 0, enwikivoyage: 1, enwikibooks: 2, appropedia: 3, usgov: 4, eips: 5, ethspecs: 6, ethereumorg: 7, bips: 8 };
const DF_MIN = 2000; // terms in fewer chunks are counted from their (short) posting lists at query time

function options() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      shards: { type: "string", multiple: true },
      pageviews: { type: "string" },
      "pageview-days": { type: "string", default: "30" },
      "full-top": { type: "string", default: "1000000" },
      "lead-chars": { type: "string", default: "2500" },
      "chunk-chars": { type: "string", default: "1000" },
      redirects: { type: "string" },
      index: { type: "string" },
      wikivoyage: { type: "string" },
      "no-embed": { type: "boolean", default: false },
      "embed-only": { type: "boolean", default: false },
      "embed-threads": { type: "string", default: "8" },
      "embed-top": { type: "string", default: "0" },
      limit: { type: "string", default: "0" },
      "delete-shards": { type: "boolean", default: false },
      "work-dir": { type: "string" },
      "min-free-gb": { type: "string", default: "0" },
      "no-optimize": { type: "boolean", default: false },
      "wait-for-shards": { type: "boolean", default: false },
      manifest: { type: "string" },
      name: { type: "string" },
      "block-kb": { type: "string", default: "64" },
      zlevel: { type: "string", default: "12" },
      help: { type: "boolean", default: false },
    },
  });
  // "--shards A B C": parseArgs keeps A under --shards and B, C as positionals.
  values.shards = [...(values.shards ?? []), ...positionals];
  if (values.help || !values.out || !values.shards.length) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  if ((values.redirects && !values.index) || (!values.redirects && values.index)) {
    throw new Error("--redirects and --index go together");
  }
  const n = (k) => Number(values[k]);
  return {
    out: values.out,
    shards: values.shards,
    pageviews: values.pageviews,
    pageviewDays: n("pageview-days"),
    fullTop: n("full-top"),
    leadChars: n("lead-chars"),
    chunkChars: n("chunk-chars"),
    maxChunkChars: Math.round(n("chunk-chars") * 1.5),
    redirects: values.redirects,
    index: values.index,
    wikivoyage: values.wikivoyage,
    embed: !values["no-embed"],
    embedOnly: values["embed-only"],
    embedThreads: n("embed-threads"),
    embedTop: n("embed-top"),
    limit: n("limit"),
    deleteShards: values["delete-shards"],
    workDir: values["work-dir"] ?? dirname(values.out),
    minFreeGb: Number(values["min-free-gb"]),
    optimize: !values["no-optimize"],
    waitForShards: values["wait-for-shards"],
    manifest: values.manifest,
    name: values.name,
    blockBytes: n("block-kb") * 1024,
    zlevel: n("zlevel"),
  };
}

/** Lines of a .bz2 file, decompressed by the system's bzcat (no bzip2 in node:zlib). */
function bz2Lines(path) {
  const child = spawn("bzcat", [path], { stdio: ["ignore", "pipe", "inherit"] });
  return createInterface({ input: child.stdout, crlfDelay: Infinity });
}

function loadPageviews(path, days) {
  const views = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    views.set(Number(line.slice(0, tab)), Math.round((Number(line.slice(tab + 1)) * 30) / days));
  }
  return views;
}

class PackWriter {
  constructor(opts) {
    this.opts = opts;
    rmSync(opts.out, { force: true });
    this.db = new DatabaseSync(opts.out);
    this.db.exec(`
      PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA page_size = 8192; PRAGMA cache_size = -1000000;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE blocks (id INTEGER PRIMARY KEY, zdata BLOB NOT NULL);
      CREATE TABLE articles (id INTEGER PRIMARY KEY, source INTEGER NOT NULL, page_id INTEGER NOT NULL, title TEXT NOT NULL,
                             views INTEGER NOT NULL, block_id INTEGER NOT NULL, off INTEGER NOT NULL, len INTEGER NOT NULL);
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL);
      CREATE VIRTUAL TABLE fts USING fts5(title, section, body, content='', detail=full,
                                          tokenize='porter unicode61 remove_diacritics 2');
    `);
    this.insArticle = this.db.prepare("INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    this.insChunk = this.db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)");
    this.insFts = this.db.prepare("INSERT INTO fts (rowid, title, section, body) VALUES (?, ?, ?, ?)");
    this.insBlock = this.db.prepare("INSERT INTO blocks VALUES (?, ?)");
    this.blockId = 1;
    this.block = [];
    this.blockLen = 0;
    this.articleId = 0;
    this.chunkId = 0;
    this.stats = { articles: 0, full: 0, chunks: 0, indexed: 0, textBytes: 0, voyage: 0 };
    this.aliases = [];
    this.pending = 0;
    this.db.exec("BEGIN");
  }

  /** Per-article URL and license, for packs mixing sources (table created on first use). */
  addMeta(id, url, license) {
    if (!this.insMeta) {
      this.db.exec("CREATE TABLE article_meta (article_id INTEGER PRIMARY KEY, url TEXT, license TEXT)");
      this.insMeta = this.db.prepare("INSERT INTO article_meta VALUES (?, ?, ?)");
    }
    this.insMeta.run(id, url ? normalizeUrl(url) : url, license);
  }

  flushBlock() {
    if (!this.blockLen) return;
    const zdata = zstdCompressSync(Buffer.concat(this.block), { params: { [zc.ZSTD_c_compressionLevel]: this.opts.zlevel } });
    this.insBlock.run(this.blockId++, zdata);
    this.block = [];
    this.blockLen = 0;
  }

  /** Adds one article; returns its id, or null if it has no text worth indexing. */
  add(source, pageId, title, views, text) {
    const spans = chunkArticle(text, this.opts.chunkChars, this.opts.maxChunkChars);
    if (!spans.length) return null;
    const id = ++this.articleId;
    const data = Buffer.from(text, "utf8");
    this.insArticle.run(id, source, pageId, title, views, this.blockId, this.blockLen, data.length);
    this.block.push(data);
    this.blockLen += data.length;
    if (this.blockLen >= this.opts.blockBytes) this.flushBlock();

    const sections = sectionsAt(text, spans);
    spans.forEach(([s, e], i) => {
      const cid = ++this.chunkId;
      this.insChunk.run(cid, id, s, e);
      const piece = text.slice(s, e);
      if (!isTable(piece)) {
        this.insFts.run(cid, title, sections[i], piece);
        this.stats.indexed++;
      }
    });
    this.stats.articles++;
    this.stats.chunks += spans.length;
    this.stats.textBytes += data.length;
    if (++this.pending >= 20000) {
      this.db.exec("COMMIT; BEGIN");
      this.pending = 0;
    }
    return id;
  }

  finishText() {
    this.flushBlock();
    this.db.exec("COMMIT");
  }
}

/** Heading path ("History > Early years") in force at each span's start; headings are "#"-lines. */
function sectionsAt(text, spans) {
  const heads = [...text.matchAll(/^(#{1,6})\s+(.*)$/gm)].map((m) => ({ at: m.index, level: m[1].length, name: m[2].trim() }));
  const out = [];
  let h = 0;
  const path = [];
  for (const [s] of spans) {
    while (h < heads.length && heads[h].at < s) {
      const { level, name } = heads[h++];
      path.length = Math.max(0, level - 1);
      path[level - 1] = name;
    }
    // path[0] is the article's own "# Title" heading
    out.push(path.slice(1).filter(Boolean).join(" > "));
  }
  return out;
}

async function addWikipedia(w, opts, views, fullIds) {
  const seen = new Set();
  const addRow = (r) => {
    const pid = Number(r.page_id);
    if (seen.has(pid) || !r.text || r.text.length < 200) return;
    if (opts.limit && w.stats.articles >= opts.limit) return;
    seen.add(pid);
    const full = !fullIds || fullIds.has(pid);
    const body = full ? r.text : leadOf(r.text, opts.leadChars);
    const box = infoboxText(r.infoboxes);
    // "# Title" heading first, then infobox facts, then the body without its own title heading
    const withoutTitle = body.replace(/^# [^\n]*\n+/, "");
    const text = `# ${r.title}\n\n${box ? `${box}\n\n` : ""}${withoutTitle}`;
    // JSONL rows may name another source and carry their own URL and license (manifest-listed packs).
    const source = r.source ? SOURCE[r.source] : SOURCE.enwiki;
    if (source === undefined) throw new Error(`unknown source "${r.source}" for "${r.title}"`);
    const id = w.add(source, pid, r.title, views?.get(pid) ?? r.views ?? 0, text);
    if (id !== null && (r.url || r.license)) w.addMeta(id, r.url ?? null, r.license ?? null);
    // Alternative names ("ERC-20", "EIP-4844") land in the redirects table like Wikipedia redirects.
    if (id !== null) for (const a of r.aliases ?? []) w.aliases.push([a, id]);
    if (id !== null && full) w.stats.full++;
  };
  // A shard given as a URL is downloaded into --work-dir just before it's needed (the next
  // one downloads while the current one is processed) and deleted afterwards.
  const fetches = new Map();
  const local = (i) => {
    const spec = opts.shards[i];
    if (!/^https?:/.test(spec)) return Promise.resolve(spec);
    if (!fetches.has(i)) fetches.set(i, downloadShard(spec, opts));
    return fetches.get(i);
  };
  for (let i = 0; i < opts.shards.length; i++) {
    const shard = await local(i);
    if (i + 1 < opts.shards.length) local(i + 1).catch(() => {}); // prefetch; errors surface when awaited
    if (shard.endsWith(".jsonl")) {
      const rows = readFileSync(shard, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      for (const r of rows) addRow(r);
      if (/^https?:/.test(opts.shards[i])) rmSync(shard);
      continue;
    }
    const file = await asyncBufferFromFile(shard);
    const md = await parquetMetadataAsync(file);
    let row = 0;
    log(`${shard}: ${md.num_rows} rows`);
    for (const rg of md.row_groups) {
      const n = Number(rg.num_rows);
      const rows = await parquetReadObjects({
        file,
        metadata: md,
        compressors,
        rowStart: row,
        rowEnd: row + n,
        columns: ["page_id", "title", "text", "infoboxes"],
      });
      row += n;
      for (const r of rows) {
        addRow(r);
        if (opts.limit && w.stats.articles >= opts.limit) return;
      }
      if (w.stats.articles % 100000 < rows.length) {
        log(`${w.stats.articles} articles (${w.stats.full} full), ${w.stats.chunks} chunks, ${(w.stats.textBytes / 1e9).toFixed(2)} GB text`);
      }
    }
    if (opts.deleteShards || /^https?:/.test(opts.shards[i])) rmSync(shard);
    shardsDone++;
    log(`shard ${i + 1}/${opts.shards.length} done; pack ${(statSync(opts.out).size / 1e9).toFixed(2)} GB, ${freeGb(opts.out).toFixed(1)} GB free`);
  }
}

let shardsDone = 0;

function freeGb(path) {
  const s = statfsSync(dirname(resolvePath(path)));
  return (s.bavail * s.bsize) / 1e9;
}

/** Waits while free disk is under --min-free-gb, logging PAUSED (whoever runs the build is told to act). */
async function waitForDisk(opts) {
  let warned = false;
  while (freeGb(opts.out) < opts.minFreeGb) {
    if (!warned) log(`PAUSED: ${freeGb(opts.out).toFixed(1)} GB free, under --min-free-gb ${opts.minFreeGb}; waiting`);
    warned = true;
    await new Promise((r) => setTimeout(r, 60000));
  }
  if (warned) log("RESUMED: enough free disk again");
}

async function downloadShard(url, opts) {
  await waitForDisk(opts);
  const dest = join(opts.workDir, url.split("/").pop());
  if (existsSync(dest)) return dest; // left by an earlier run, or by --wait-for-shards' downloader
  if (opts.waitForShards) {
    // Another process (scripts/fetch-shards.sh) downloads into --work-dir at normal priority, so a
    // background-priority build isn't also throttled on the network.
    log(`waiting for ${dest}`);
    while (!existsSync(dest)) await new Promise((r) => setTimeout(r, 30000));
    return dest;
  }
  mkdirSync(opts.workDir, { recursive: true });
  log(`downloading ${url}`);
  // curl resumes a partial file (-C -) and retries dropped connections; a 2.5 GB fetch() can't resume.
  await new Promise((ok, fail) => {
    const c = spawn("curl", ["-fsSL", "-C", "-", "--retry", "20", "--retry-all-errors", "--retry-delay", "10", "-o", `${dest}.part`, url], { stdio: ["ignore", "ignore", "inherit"] });
    c.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${url}: curl exit ${code}`))));
    c.on("error", fail);
  });
  renameSync(`${dest}.part`, dest);
  return dest;
}

async function addWikivoyage(w, path) {
  const redirects = [];
  let buf = "";
  const child = spawn("bzcat", [path], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  for await (const piece of child.stdout) {
    buf += piece;
    let end;
    while ((end = buf.indexOf("</page>")) >= 0) {
      const start = buf.indexOf("<page>");
      const page = parseDumpPage(buf.slice(start, end));
      buf = buf.slice(end + 7);
      if (page.ns !== "0") continue;
      if (page.redirect) {
        redirects.push([page.title, page.redirect]);
        continue;
      }
      const body = cleanWikivoyage(page.text);
      if (body.length < 200) continue;
      if (w.add(SOURCE.enwikivoyage, page.id, page.title, 0, `# ${page.title}\n\n${body}`) !== null) w.stats.voyage++;
    }
  }
  log(`wikivoyage: ${w.stats.voyage} guides, ${redirects.length} redirects`);
  return redirects;
}

/** Wikipedia redirects whose target is in the pack; joined in a scratch database to keep memory small. */
async function addRedirects(db, opts, voyageRedirects, aliases = []) {
  db.exec(`CREATE TABLE redirects (title TEXT NOT NULL COLLATE NOCASE, article_id INTEGER NOT NULL, PRIMARY KEY (title, article_id)) WITHOUT ROWID`);
  const ins = db.prepare("INSERT OR IGNORE INTO redirects VALUES (?, ?)");
  db.exec("BEGIN");
  if (opts.redirects) {
    const scratchPath = `${opts.out}.redirects.tmp`;
    rmSync(scratchPath, { force: true });
    const s = new DatabaseSync(scratchPath);
    s.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
            CREATE TABLE rd (rd_from INTEGER PRIMARY KEY, target TEXT NOT NULL);
            CREATE TABLE idx (page_id INTEGER PRIMARY KEY, title TEXT NOT NULL);`);
    const insRd = s.prepare("INSERT OR IGNORE INTO rd VALUES (?, ?)");
    s.exec("BEGIN");
    const gz = createInterface({ input: createReadStream(opts.redirects).pipe(createGunzip()), crlfDelay: Infinity });
    let n = 0;
    for await (const line of gz) for (const [from, target] of parseRedirectRows(line)) (insRd.run(from, target), n++);
    s.exec("COMMIT; BEGIN");
    log(`redirect rows: ${n}`);
    const insIdx = s.prepare("INSERT OR IGNORE INTO idx SELECT ?, ? WHERE EXISTS (SELECT 1 FROM rd WHERE rd_from = ?)");
    for await (const line of bz2Lines(opts.index)) {
      const p = parseIndexLine(line);
      if (p) insIdx.run(p[0], p[1], p[0]);
    }
    s.exec("COMMIT");
    s.close();
    db.exec(`ATTACH '${scratchPath.replace(/'/g, "''")}' AS scratch`);
    db.exec(`CREATE INDEX articles_title ON articles (title COLLATE NOCASE)`);
    const r = db.prepare(`
      INSERT OR IGNORE INTO redirects
      SELECT i.title, a.id FROM scratch.rd r JOIN scratch.idx i ON i.page_id = r.rd_from
      JOIN articles a ON a.title = r.target COLLATE NOCASE AND a.source = ${SOURCE.enwiki}`).run();
    log(`wikipedia redirects into the pack: ${r.changes}`);
    db.exec("COMMIT; DETACH scratch; BEGIN");
    rmSync(scratchPath, { force: true });
  } else {
    db.exec(`CREATE INDEX articles_title ON articles (title COLLATE NOCASE)`);
  }
  const target = db.prepare(`SELECT id FROM articles WHERE title = ? COLLATE NOCASE AND source = ${SOURCE.enwikivoyage}`);
  for (const [from, to] of voyageRedirects) {
    const row = target.get(to);
    if (row) ins.run(from, row.id);
  }
  for (const [title, id] of aliases) ins.run(title, id);
  db.exec("COMMIT");
}

/** Lead chunks in article order, read back from the pack in batches (a full build has millions). */
function* leadBatches(db, size, top) {
  const block = db.prepare("SELECT zdata FROM blocks WHERE id = ?");
  // With --embed-top N: Wikipedia's N most-viewed articles (ties at the cut included) and every Wikivoyage guide.
  const cut = top
    ? db.prepare(`SELECT views FROM articles WHERE source = ${SOURCE.enwiki} ORDER BY views DESC LIMIT 1 OFFSET ?`).get(top - 1)?.views ?? 0
    : 0;
  const rows = db.prepare(
    `SELECT a.id, a.title, a.block_id, a.off, a.len, c.start, c.end FROM articles a
     JOIN chunks c ON c.article_id = a.id
     WHERE a.source = ${SOURCE.enwikivoyage} OR a.views >= ${Math.max(cut, top ? 1 : 0)}
     ORDER BY a.id, c.id`
  );
  let cachedId = 0;
  let cached = null;
  let batch = [];
  let lastArticle = 0;
  let firstOfArticle = [];
  const emit = () => {
    if (!firstOfArticle.length) return;
    const [first, second] = firstOfArticle;
    const a = first;
    if (cachedId !== a.block_id) {
      cached = zstdDecompressSync(block.get(a.block_id).zdata);
      cachedId = a.block_id;
    }
    const text = cached.subarray(a.off, a.off + a.len).toString("utf8");
    const spans = [[first.start, first.end], ...(second ? [[second.start, second.end]] : [])];
    const [s, e] = spans[leadChunkIndex(text, spans)];
    batch.push({ articleId: a.id, title: a.title, body: text.slice(s, e) });
  };
  for (const r of rows.iterate()) {
    if (r.id !== lastArticle) {
      emit();
      if (batch.length >= size) {
        yield batch;
        batch = [];
      }
      lastArticle = r.id;
      firstOfArticle = [r];
    } else if (firstOfArticle.length < 2) {
      firstOfArticle.push(r);
    }
  }
  emit();
  if (batch.length) yield batch;
}

async function addLeadEmbeddings(db, opts) {
  await ensureEmbeddingModel();
  db.exec("CREATE TABLE lead_vecs (article_id INTEGER PRIMARY KEY, scale REAL NOT NULL, vec BLOB NOT NULL)");
  const ins = db.prepare("INSERT INTO lead_vecs VALUES (?, ?, ?)");
  const caches = [];
  let n = 0;
  // Each batch has its own cache file, so an interrupted build re-embeds at most one batch.
  for (const leads of leadBatches(db, 50000, opts.embedTop)) {
    const cache = `${opts.out}.leads-${n}-${leads.length}.f32`;
    caches.push(cache);
    const { data, scales } = quantizeInt8(await embedChunks(leads, cache, opts.embedThreads), 384);
    db.exec("BEGIN");
    leads.forEach((l, i) => ins.run(l.articleId, scales[i], Buffer.from(data.buffer, data.byteOffset + i * 384, 384)));
    db.exec("COMMIT");
    n += leads.length;
    log(`lead embeddings: ${n}`);
  }
  return caches;
}

/** meta.sources / meta.license / meta.manifestSha256 from a topic pack's manifest. */
function manifestMeta(path) {
  const raw = readFileSync(path);
  const docs = JSON.parse(raw.toString("utf8"));
  const sources = {};
  for (const d of docs) {
    const s = (sources[d.source] ??= { documents: 0, licenses: {} });
    s.documents++;
    s.licenses[d.license] = (s.licenses[d.license] ?? 0) + 1;
  }
  return {
    sources: JSON.stringify(sources),
    license: [...new Set(docs.map((d) => d.license))].join("; "),
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function tableBytes(db) {
  try {
    return Object.fromEntries(
      db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all().map((r) => [r.name, r.bytes])
    );
  } catch {
    return null; // dbstat isn't compiled into every SQLite
  }
}

async function main() {
  const opts = options();
  const t0 = Date.now();
  const views = opts.pageviews ? loadPageviews(opts.pageviews, opts.pageviewDays) : null;
  let fullIds = null;
  if (views) {
    fullIds = new Set([...views.keys()].sort((a, b) => views.get(b) - views.get(a)).slice(0, opts.fullTop));
    log(`pageviews for ${views.size} pages; the top ${fullIds.size} are kept in full`);
  }
  let w;
  let wikiArticles;
  if (opts.embedOnly) {
    // Pick up a pack whose text, redirects and index are already written.
    const db = new DatabaseSync(opts.out);
    // With --no-embed this only rewrites the metadata and keeps existing embeddings.
    db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; ${opts.embed ? "DROP TABLE IF EXISTS lead_vecs;" : ""} DELETE FROM meta;`);
    const n = (sql) => db.prepare(sql).get().n;
    const stats = {
      articles: n("SELECT COUNT(*) AS n FROM articles"),
      full: null,
      chunks: n("SELECT COUNT(*) AS n FROM chunks"),
      indexed: n("SELECT COUNT(*) AS n FROM fts_docsize"),
      textBytes: n("SELECT SUM(len) AS n FROM articles"),
      voyage: n(`SELECT COUNT(*) AS n FROM articles WHERE source = ${SOURCE.enwikivoyage}`),
    };
    w = { db, stats };
    wikiArticles = stats.articles - stats.voyage;
    log(`embedding leads of an existing pack: ${JSON.stringify(stats)}`);
  } else {
    w = new PackWriter(opts);
    await addWikipedia(w, opts, views, fullIds);
    wikiArticles = w.stats.articles;
    const voyageRedirects = opts.wikivoyage ? await addWikivoyage(w, opts.wikivoyage) : [];
    w.finishText();
    log(`text done: ${JSON.stringify(w.stats)}`);

    await addRedirects(w.db, opts, voyageRedirects, w.aliases);
    w.db.exec(`CREATE INDEX chunks_article ON chunks (article_id)`);

    if (opts.optimize) {
      log("optimizing the keyword index");
      w.db.exec("INSERT INTO fts (fts) VALUES ('optimize')");
    }
    w.db.exec(`CREATE VIRTUAL TABLE temp.fts_v USING fts5vocab(main, 'fts', 'row');
               CREATE TABLE df (term TEXT PRIMARY KEY, doc INTEGER NOT NULL) WITHOUT ROWID;
               INSERT INTO df SELECT term, doc FROM temp.fts_v WHERE doc >= ${DF_MIN};`);
  }
  const embedCaches = opts.embed ? await addLeadEmbeddings(w.db, opts) : [];

  const meta = {
    format: "boar-knowledge-pack",
    formatVersion: 2,
    dims: 384,
    // Also when a metadata-only run (--embed-only --no-embed) keeps embeddings made earlier.
    embeddingModelSha256:
      opts.embed || w.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'lead_vecs'").get() ? EMBEDDING_MODEL.sha256 : "",
    // A topic pack (--manifest, e.g. scripts/fetch-preparedness.mjs) lists every document with its source,
    // URL and license; the meta keeps per-source counts and licenses and the manifest's hash.
    ...(opts.manifest
      ? manifestMeta(opts.manifest)
      : {
          sources: JSON.stringify({
            enwiki: { dataset: "HuggingFaceFW/finewiki (enwiki, Enterprise HTML dumps of August 2025)", shards: opts.shards.map((s) => s.split("/").pop()), articles: wikiArticles },
            ...(opts.wikivoyage ? { enwikivoyage: { dump: opts.wikivoyage.split("/").pop(), articles: w.stats.voyage } } : {}),
            ...(opts.redirects ? { redirects: opts.redirects.split("/").pop() } : {}),
            ...(opts.pageviews ? { pageviews: opts.pageviews.split("/").pop(), days: opts.pageviewDays } : {}),
          }),
          license: "CC BY-SA 4.0 (Wikipedia, Wikivoyage)",
        }),
    ...(opts.name ? { name: opts.name } : {}),
    articles: w.stats.articles,
    chunks: w.stats.chunks,
    indexedChunks: w.stats.indexed,
    dfMin: DF_MIN,
    params: JSON.stringify({ fullTop: opts.fullTop, leadChars: opts.leadChars, chunkChars: opts.chunkChars, blockKb: opts.blockBytes / 1024, zlevel: opts.zlevel, limit: opts.limit, embedTop: opts.embedTop }),
    builtAt: new Date().toISOString(),
  };
  const setMeta = w.db.prepare("INSERT INTO meta VALUES (?, ?)");
  for (const [k, v] of Object.entries(meta)) setMeta.run(k, String(v));
  const tables = tableBytes(w.db);
  w.db.close();
  for (const c of embedCaches) rmSync(c, { force: true });

  const sizeBytes = statSync(opts.out).size;
  const summary = {
    file: opts.out,
    sizeBytes,
    sha256: await sha256File(opts.out),
    ...w.stats,
    tables,
    buildSeconds: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(`${opts.out}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(`\n✗ ${e.stack ?? e.message}`);
  process.exit(1);
});
