/**
 * Knowledge packs: SQLite files built on a computer by
 * scripts/build-knowledge-pack.mjs (docs/KNOWLEDGE_PACKS.md), each with its
 * own FTS5 index and int8 embeddings made with the app's embedding model.
 * They're opened read-only and searched alongside the built-in knowledge base.
 *
 * Search is keyword-first: FTS5 picks up to PACK_CANDIDATES chunks, and only
 * those are compared with the question's embedding. Scanning every embedding
 * of a large pack on each question would take seconds on the phone's JS engine.
 */
import * as SQLite from "expo-sqlite";
import * as FileSystem from "expo-file-system/legacy";
import { CORPUS_CATALOG, MODEL_CATALOG, CatalogModel } from "../models/manifest";
import { buildLexicalQuery, cosineSimilarityInt8, filterByMinScore, filterByTermCoverage, MIN_SEMANTIC_SIMILARITY } from "./pure";
import type { RetrievedChunk } from "./retrieve.types";
import { decompress } from "fzstd";
import { WikiPack, type PackHit, type PackSearchOptions, type Stem } from "./wikiPack";
import { guard, type Guarded } from "./guardedDb";
import { registerResetHook } from "../services/resetOrder";
import { EXPLAIN_INTENT, explainingFirst } from "./explain";

const PACK_CANDIDATES = 400;
const EMBEDDING_SHA256 = MODEL_CATALOG.find((m) => m.kind === "embedding" && m.required)!.sha256;

// Guarded connections (src/rag/guardedDb.ts): closing one waits for the searches running on it (RS-1).
const openPacks = new Map<string, Guarded<SQLite.SQLiteDatabase>>();
// One open at a time per pack: two searches starting together share it instead of opening the file twice.
const opening = new Map<string, Promise<SQLite.SQLiteDatabase | null>>();
// Bumped by closeAllPacks(): an open still in progress then closes what it opened instead of keeping it.
let generation = 0;
/** Format-2 packs (scripts/build-wiki-pack.mjs), keyed like openPacks. */
const wikiPacks = new Map<string, WikiPack>();
// Packs that failed the format check, by id, with the file size they had: not reopened on every
// search while the same file is there (a new download changes the size, or closePack clears it).
const rejected = new Map<string, number>();

const CORPUS_DIR = "corpus/";

/**
 * Catalog packs, plus any other pack file in corpus/ (e.g. one built with
 * scripts/build-knowledge-pack.mjs and copied over with npm run pack:push).
 * Those have no catalog size to check, only the format and model checks in openPack.
 */
export async function knowledgePacks(): Promise<CatalogModel[]> {
  const catalog = CORPUS_CATALOG.filter((m) => m.format === "sqlite-pack");
  const names = await FileSystem.readDirectoryAsync(`${FileSystem.documentDirectory}${CORPUS_DIR}`).catch(() => [] as string[]);
  const extra = names
    .filter((n) => n.endsWith(".sqlite") && !catalog.some((c) => c.filename === `${CORPUS_DIR}${n}`))
    .map(
      (n): CatalogModel => ({
        id: `local-${n.replace(/\.sqlite$/, "")}`,
        kind: "corpus",
        format: "sqlite-pack",
        label: n,
        filename: `${CORPUS_DIR}${n}`,
        sizeBytes: 0,
        sha256: "",
        sourceUrl: "",
        license: "",
        description: "",
        required: false,
      })
    );
  return [...catalog, ...extra];
}

/**
 * Stops using a pack (before its file is deleted): later calls on its connection reject in JS. The native connection
 * is NOT closed: expo-sqlite 57's close crashes on connections that used FTS5 (RS-1); it goes when the app exits,
 * and deleting the file under it is fine on Android and iOS. Idempotent.
 */
export async function closePack(id: string): Promise<void> {
  const conn = openPacks.get(id);
  openPacks.delete(id);
  wikiPacks.delete(id);
  rejected.delete(id);
  conn?.retire();
}

/** Forgets every pack (reset), including ones still being opened, without closing them natively. Idempotent. */
export async function forgetAllPacks(): Promise<void> {
  generation++;
  await Promise.all([...opening.values()].map((p) => p.catch(() => null)));
  await Promise.all([...openPacks.keys()].map(closePack));
  rejected.clear();
}

/** @deprecated The reset forgets packs (forgetAllPacks); kept for callers of the first reset contract. */
export const closeAllPacks = forgetAllPacks;

registerResetHook("forget", "packs", forgetAllPacks);

/** The pack's database if it's fully downloaded and built for this app's embedding model, else null. */
async function openPack(pack: CatalogModel): Promise<SQLite.SQLiteDatabase | null> {
  const uri = `${FileSystem.documentDirectory}${pack.filename}`;
  const info = await FileSystem.getInfoAsync(uri);
  // Catalog packs must be complete; a local pack (sizeBytes 0) has nothing to compare against.
  if (!info.exists || (pack.sizeBytes > 0 && info.size !== pack.sizeBytes)) {
    await closePack(pack.id);
    return null;
  }
  if (rejected.get(pack.id) === info.size) return null;
  const cached = openPacks.get(pack.id);
  if (cached) return cached.db;
  const pending = opening.get(pack.id);
  if (pending) return pending;
  const started = generation;
  const p = openPackFile(pack, uri, started, info.size).finally(() => opening.delete(pack.id));
  opening.set(pack.id, p);
  return p;
}

async function openPackFile(pack: CatalogModel, uri: string, started: number, size: number): Promise<SQLite.SQLiteDatabase | null> {
  const path = uri.replace(/^file:\/\//, "");
  const slash = path.lastIndexOf("/");
  const conn = guard(await SQLite.openDatabaseAsync(path.slice(slash + 1), { useNewConnection: true }, path.slice(0, slash)), `pack ${pack.id}`);
  const db = conn.db;
  const meta = await db
    .getAllAsync<{ key: string; value: string }>("SELECT key, value FROM meta")
    .then((rows) => Object.fromEntries(rows.map((r) => [r.key, r.value])))
    .catch(() => ({} as Record<string, string>));
  // Format 2 may be built without embeddings (empty embeddingModelSha256); format 1 always has them.
  const embeddingsOk = meta.embeddingModelSha256 === EMBEDDING_SHA256 || (meta.formatVersion === "2" && !meta.embeddingModelSha256);
  if (meta.format !== "boar-knowledge-pack" || !embeddingsOk) {
    console.warn(`[packs] ${pack.filename} isn't a knowledge pack for this app's embedding model; skipping it`);
    rejected.set(pack.id, size);
    conn.retire();
    return null;
  }
  if (meta.formatVersion === "2") {
    try {
      wikiPacks.set(pack.id, await WikiPack.open(db, decompress));
    } catch (e: any) {
      console.warn(`[packs] ${pack.filename} failed to open:`, e?.message ?? e);
      rejected.set(pack.id, size);
      conn.retire();
      return null;
    }
  }
  if (generation !== started) {
    // closeAllPacks() ran while this pack was opening (a reset): don't keep a connection to a file about to go.
    wikiPacks.delete(pack.id);
    conn.retire();
    return null;
  }
  openPacks.set(pack.id, conn);
  return db;
}

export interface WikiPackResult {
  packId: string;
  pack: WikiPack;
  hits: PackHit[];
  stems: Stem[];
}

/** Searches every installed format-2 pack (a failing pack is skipped). */
export async function searchWikiPacks(query: string, opts: PackSearchOptions = {}): Promise<WikiPackResult[]> {
  const out: WikiPackResult[] = [];
  for (const pack of await knowledgePacks()) {
    try {
      if (!(await openPack(pack))) continue;
      const wp = wikiPacks.get(pack.id);
      if (!wp) continue;
      const { hits, stems } = await wp.searchDetailed(query, opts);
      out.push({ packId: pack.id, pack: wp, hits, stems });
    } catch (e: any) {
      console.warn(`[packs] search failed in ${pack.id}:`, e?.message ?? e);
    }
  }
  return out;
}

const SOURCE_LABEL: Record<PackHit["source"], string> = {
  enwiki: "Wikipedia",
  enwikivoyage: "Wikivoyage",
  enwikibooks: "Wikibooks",
  appropedia: "Appropedia",
  usgov: "US government",
  eips: "Ethereum EIPs/ERCs",
  ethspecs: "Ethereum specs",
  ethereumorg: "ethereum.org",
  bips: "Bitcoin BIPs",
};

/** URL of a pack article: its recorded URL, else the Wikipedia/Wikivoyage/Wikibooks page for its title. */
/**
 * A recorded page URL made safe to show and open: a raw title with spaces ("…/wiki/Quantum cryptography") gets
 * underscores on wiki paths and %20 elsewhere, then any other unencoded character is encoded (already-encoded
 * URLs are left as they are).
 */
export function normalizeUrl(url: string): string {
  const spaced = /\/wiki\//.test(url) ? url.replace(/ /g, "_") : url.replace(/ /g, "%20");
  try {
    return encodeURI(decodeURI(spaced));
  } catch {
    return spaced;
  }
}

export function articleUrl(title: string, source: PackHit["source"], url?: string): string {
  if (url) return normalizeUrl(url);
  const host = source === "enwikivoyage" ? "en.wikivoyage.org" : source === "enwikibooks" ? "en.wikibooks.org" : "en.wikipedia.org";
  return `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** A format-2 pack hit in the shape the chat's retrieval uses. */
export function packHitToChunk(packId: string, h: PackHit): RetrievedChunk {
  const label = SOURCE_LABEL[h.source] ?? "Source";
  return {
    chunkId: `pack:${packId}:${h.chunkId}`,
    docId: `pack:${packId}:a${h.articleId}`,
    title: h.source === "enwiki" ? h.title : `${label}: ${h.title}`,
    body: h.section ? `${h.section}: ${h.text}` : h.text,
    source: `${label} — ${articleUrl(h.title, h.source, h.url)}${h.license ? ` (${h.license})` : ""}`,
    score: h.score,
    matchType: "lexical",
    action: h.action,
  };
}

type PackRow = { id: number; title: string; body: string; vec: Uint8Array; rank: number };

/** Lexical and semantic candidates from every installed pack, scored like the built-in ones. */
export async function searchPacks(
  query: string,
  queryVec: Float32Array,
  limit: number,
  opts: { explain?: boolean } = {}
): Promise<{ lexical: RetrievedChunk[]; semantic: RetrievedChunk[] }> {
  const lexicalQuery = buildLexicalQuery(query);
  const lexical: RetrievedChunk[] = [];
  const semantic: RetrievedChunk[] = [];
  if (!lexicalQuery) return { lexical, semantic };

  for (const pack of await knowledgePacks()) {
    try {
      const db = await openPack(pack);
      if (!db || wikiPacks.has(pack.id)) continue;
      const rows = await db.getAllAsync<PackRow>(
        `SELECT c.id, c.title, c.body, c.vec, bm25(chunks_fts) AS rank
         FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
        [lexicalQuery.match, PACK_CANDIDATES]
      );
      const toChunk = (r: PackRow, score: number, matchType: RetrievedChunk["matchType"]): RetrievedChunk => ({
        similarity: cosineSimilarityInt8(queryVec, r.vec),
        chunkId: `pack:${pack.id}:${r.id}`,
        docId: `pack:${pack.id}:${r.title}`,
        title: r.title,
        body: r.body,
        score,
        matchType,
      });
      let lex = filterByTermCoverage(rows, lexicalQuery.terms).slice(0, limit).map((r) => toChunk(r, -r.rank, "lexical"));
      const scored = rows.map((r) => toChunk(r, cosineSimilarityInt8(queryVec, r.vec), "semantic"));
      scored.sort((a, b) => b.score - a.score);
      let sem = filterByMinScore(scored, MIN_SEMANTIC_SIMILARITY).slice(0, limit);
      // A why/what-causes question: within an article, the chunk with the question's other words first (RF-1).
      if (opts.explain ?? EXPLAIN_INTENT.test(query)) {
        lex = explainingFirst(lex, lexicalQuery.terms);
        sem = explainingFirst(sem, lexicalQuery.terms);
      }
      lexical.push(...lex);
      semantic.push(...sem);
    } catch (e: any) {
      console.warn(`[packs] search failed in ${pack.id}:`, e?.message ?? e);
    }
  }
  return { lexical, semantic };
}
