import { getDb } from "./db";
import { embeddingEngine } from "./embed";
import {
  buildLexicalQuery,
  cosineSimilarity,
  filterByMinScore,
  filterByTermCoverage,
  fuseRetrievalResults,
  gateByRelevance,
  MIN_SEMANTIC_SIMILARITY,
  personalHits,
  SCOPED_MIN_SIMILARITY,
} from "./pure";
import type { RetrievedChunk } from "./retrieve.types";
import { packHitToChunk, searchPacks, searchWikiPacks } from "./packs";
import { englishNamesIn, looksPortuguese, type Lexicon } from "./ptLexicon";
import { ACTION_INTENT, LAY_SOURCES } from "./wikiPack";
import { EXPLAIN_INTENT } from "./explain";
import { identifiersIn, titleHasIdentifier } from "./identifiers";
import { ptLexicon } from "./ptLexiconAsset";
import { dedupeArticleCopies } from "./dedupe";

export type { RetrievedChunk } from "./retrieve.types";

// Extra BM25 candidates fetched so the term-coverage gate has something to
// choose from; the result is still capped at `limit`.
const LEXICAL_CANDIDATE_MULTIPLIER = 4;

// Places at the top of the sources reserved for the user's own documents (personalHits, src/rag/pure.ts): half,
// so a question about an imported PDF gets it even with a big Wikipedia pack installed, and other sources keep room.
const PERSONAL_SLOTS = 3;

/**
 * Which sources a search may use: only these imported collections, active or not (the user picked them), and the
 * bundled corpus and knowledge packs only when `builtin`. Used by "Ask this document" (builtin false) and the
 * desktop's MCP server (desktop/docs/09-mcp.md). Unset: every active collection and every source.
 */
export interface RetrievalScope {
  collections: string[];
  builtin: boolean;
}

/** The WHERE clause on chunks c / custom_collections cc for a scope, and its parameters. */
function scopeFilter(scope?: RetrievalScope): { sql: string; params: string[] } {
  if (!scope) return { sql: "(c.collection_id IS NULL OR cc.active = 1)", params: [] };
  const mine = scope.collections.length
    ? `c.collection_id IN (${scope.collections.map(() => "?").join(", ")})`
    : "0";
  return { sql: scope.builtin ? `(c.collection_id IS NULL OR ${mine})` : mine, params: scope.collections };
}

/**
 * BM25-ranked FTS5 lexical search over the local knowledge base. The query
 * is reduced to its content words, OR-ed (buildLexicalQuery), and hits
 * must cover enough of those words to count (filterByTermCoverage). That
 * coverage rule is this search's relevance gate. No numeric bm25 floor is
 * applied: bm25's scale depends on the corpus and query.
 */
async function lexicalSearch(query: string, queryVec: Float32Array, limit: number, scope?: RetrievalScope): Promise<RetrievedChunk[]> {
  const lexicalQuery = buildLexicalQuery(query);
  if (!lexicalQuery) return [];
  const db = await getDb();
  const where = scopeFilter(scope);
  const rows = await db.getAllAsync<{
    chunk_id: string;
    doc_id: string;
    title: string;
    body: string;
    rank: number;
    embedding: Uint8Array | null;
    collection_id: string | null;
    source: string | null;
  }>(
    `SELECT f.chunk_id, f.doc_id, f.title, f.body, bm25(chunks_fts) AS rank, e.embedding, c.collection_id, c.source
     FROM chunks_fts f
     JOIN chunks c ON c.chunk_id = f.chunk_id
     LEFT JOIN chunk_embeddings e ON e.chunk_id = f.chunk_id
     LEFT JOIN custom_collections cc ON cc.id = c.collection_id
     WHERE chunks_fts MATCH ? AND ${where.sql}
     ORDER BY rank LIMIT ?`,
    [lexicalQuery.match, ...where.params, limit * LEXICAL_CANDIDATE_MULTIPLIER]
  );
  return filterByTermCoverage(rows, lexicalQuery.terms).slice(0, limit).map((r) => ({
    chunkId: r.chunk_id,
    docId: r.doc_id,
    title: r.title,
    body: r.body,
    ...(r.collection_id ? { collectionId: r.collection_id } : {}),
    ...(r.source ? { source: r.source } : {}),
    score: -r.rank, // bm25() returns lower-is-better; invert for consistent "higher is better"
    // The relevance gate needs a similarity; without it a keyword-only hit would always be dropped.
    similarity: r.embedding ? cosineSimilarity(queryVec, toVector(r.embedding)) : undefined,
    matchType: "lexical" as const,
  }));
}

function toVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/** Brute-force cosine search over stored embeddings; fine at knowledge-base scale on-device. */
async function semanticSearch(queryVec: Float32Array, limit: number, scope?: RetrievalScope, minSimilarity = MIN_SEMANTIC_SIMILARITY): Promise<RetrievedChunk[]> {
  const db = await getDb();
  const where = scopeFilter(scope);

  const rows = await db.getAllAsync<{
    chunk_id: string;
    doc_id: string;
    title: string;
    body: string;
    embedding: Uint8Array;
    collection_id: string | null;
    source: string | null;
  }>(
    `SELECT c.chunk_id, c.doc_id, c.title, c.body, e.embedding, c.collection_id, c.source
     FROM chunk_embeddings e
     JOIN chunks c ON c.chunk_id = e.chunk_id
     LEFT JOIN custom_collections cc ON cc.id = c.collection_id
     WHERE ${where.sql}`,
    where.params
  );

  const scored = rows.map((r) => {
    const similarity = cosineSimilarity(queryVec, toVector(r.embedding));
    return {
      chunkId: r.chunk_id,
      docId: r.doc_id,
      title: r.title,
      body: r.body,
      ...(r.collection_id ? { collectionId: r.collection_id } : {}),
      ...(r.source ? { source: r.source } : {}),
      score: similarity,
      similarity,
      matchType: "semantic" as const,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return filterByMinScore(scored, minSimilarity).slice(0, limit);
}

/**
 * Hybrid retrieval: union lexical (BM25, exact-phrase-gated) + semantic
 * (cosine, MIN_SEMANTIC_SIMILARITY-gated) results, re-ranked by a simple
 * weighted-sum fusion (fuseRetrievalResults, src/rag/pure.ts — extracted
 * there so the fusion/threshold mechanics are unit-testable without a real
 * device; see retrieve.relevance.test.ts). No network calls. If neither
 * source has anything relevant, this returns [] — never a forced top-K of
 * whatever happened to be least-irrelevant.
 */
export async function retrieve(
  query: string,
  topK = 6,
  opts: { queryVec?: Float32Array; includeWikiPacks?: boolean; lexicon?: Lexicon; collections?: string[]; scope?: RetrievalScope } = {}
): Promise<RetrievedChunk[]> {
  if (opts.collections?.length) return retrieveScoped(query, topK, opts.collections, opts.queryVec);
  const main = await retrieveOne(query, topK, opts);
  // A Portuguese question against English sources: search again with the English names it mentions
  // (Wikipedia's own interlanguage links, src/rag/ptLexicon.ts), and put those results first. The English
  // embedder and keyword index barely match Portuguese words, so the first search alone finds noise.
  if (!looksPortuguese(query)) return main;
  // A standard's number in the question (EIP-1559, ERC-20, BIP-32) names its page exactly: it goes before any
  // lexicon name, which for these questions is often only the generic "Ethereum".
  const ids = identifiersIn(query);
  const names = [...ids, ...englishNamesIn(query, opts.lexicon ?? ptLexicon()).filter((n) => !ids.includes(n))];
  if (!names.length) return main;
  // The names alone ("Earthquake") don't say the question asks what to do; the question does.
  const found = await retrieveOne(names.join(" "), topK, {
    includeWikiPacks: opts.includeWikiPacks,
    scope: opts.scope,
    titles: names,
    action: ACTION_INTENT.test(query),
    explain: EXPLAIN_INTENT.test(query),
  });
  // Sources without a title boost (bundled corpus, format-1 packs): the article whose title is one of the names first.
  const named = new Set(names.map((n) => n.toLowerCase()));
  // A what-to-do question: passages from a section that says what to do (the preparedness pack's Treatment,
  // First aid, During…) first; then articles named exactly; disambiguation lists never.
  const action = ACTION_INTENT.test(query);
  const rank = (c: RetrievedChunk) => (action && c.action ? 0 : named.has(c.title.toLowerCase()) ? 1 : 2);
  const english = found.filter((c) => !isDisambiguation(c)).sort((a, b) => rank(a) - rank(b));
  const seen = new Set<string>();
  // In a what-to-do question only steps go first: a generic name ("estrada" -> Road) must not put its article
  // ahead of everything else.
  const first = action ? english.filter((c) => c.action) : english;
  const merged = [...first.slice(0, Math.ceil((topK * 2) / 3)), ...main, ...english].filter(
    (c) => !isDisambiguation(c) && !seen.has(c.chunkId) && (seen.add(c.chunkId), true)
  );
  // The user's own documents first (retrieveOne put them first in both searches), then the page of a standard the
  // question names by number.
  const byId = (c: RetrievedChunk) => ids.some((id) => titleHasIdentifier(c.title, id));
  const mine = merged.filter((c) => c.collectionId).slice(0, PERSONAL_SLOTS);
  const rest = merged.filter((c) => !mine.includes(c));
  return dedupeArticleCopies([...mine, ...rest.filter(byId), ...rest.filter((c) => !byId(c))]).slice(0, topK);
}

/**
 * "Ask this document": only the given collections, no bundled corpus, no packs. The user named the source, so its
 * passages get a looser semantic gate (scopedHits, src/rag/pure.ts) and the answer step may still find them wanting.
 */
async function retrieveScoped(query: string, topK: number, collections: string[], vec?: Float32Array): Promise<RetrievedChunk[]> {
  const queryVec = vec ?? (await embeddingEngine.embed(query));
  const [lexical, semantic] = await Promise.all([
    lexicalSearch(query, queryVec, topK * 2, { collections, builtin: false }),
    semanticSearch(queryVec, topK * 2, { collections, builtin: false }, SCOPED_MIN_SIMILARITY),
  ]);
  return personalHits(lexical, semantic, topK, SCOPED_MIN_SIMILARITY);
}

/** A "may refer to" list or a "(disambiguation)" page: never a source. */
export function isDisambiguation(c: { title: string; body: string }): boolean {
  return /\(disambiguation\)$/i.test(c.title) || /\bmay (also )?refer to\b/i.test(c.body.slice(0, 300));
}

async function retrieveOne(
  query: string,
  topK: number,
  opts: { queryVec?: Float32Array; includeWikiPacks?: boolean; titles?: string[]; action?: boolean; explain?: boolean; scope?: RetrievalScope }
): Promise<RetrievedChunk[]> {
  const { titles, scope } = opts;
  const builtin = scope?.builtin ?? true;
  const includeWikiPacks = (opts.includeWikiPacks ?? true) && builtin;
  const queryVec = opts.queryVec ?? (await embeddingEngine.embed(query));
  const [lexical, semantic, packs, wiki] = await Promise.all([
    lexicalSearch(query, queryVec, topK * 2, scope),
    semanticSearch(queryVec, topK * 2, scope),
    // Downloaded knowledge packs (src/rag/packs.ts); a failing pack is skipped, never fatal.
    builtin
      ? searchPacks(query, queryVec, topK * 2, opts.explain !== undefined ? { explain: opts.explain } : {}).catch(() => ({ lexical: [], semantic: [] }))
      : Promise.resolve({ lexical: [], semantic: [] }),
    includeWikiPacks
      ? searchWikiPacks(query, {
          k: topK,
          queryVec,
          ...(titles ? { titles } : {}),
          ...(opts.action !== undefined ? { action: opts.action } : {}),
          ...(opts.explain !== undefined ? { explain: opts.explain } : {}),
        }).catch(() => [])
      : Promise.resolve([]),
  ]);

  // Large-pack passages from articles the question names come first, in the
  // pack's own order; its keyword hits compete with everything else.
  // A named disambiguation page is a list of links, not a source to put first (any pack, any language).
  const named = wiki
    .flatMap((w) => w.hits.filter((h) => h.via === "title").map((h) => packHitToChunk(w.packId, h)))
    .filter((c) => !isDisambiguation(c));
  const wikiLexical = wiki.flatMap((w) => w.hits.filter((h) => h.via !== "title").map((h) => packHitToChunk(w.packId, h)));
  // The bundled corpus and format-1 packs pass the relevance gate first (their chunks carry the
  // question's cosine similarity): an unrelated question gets none of them, and weak chunks can't
  // take the top-K or per-article slots before the gate sees the rest. Large-pack hits have their
  // own ranking and no similarity, so they aren't gated here.
  const fused = fuseRetrievalResults(
    [...gateByRelevance([...lexical, ...packs.lexical]), ...wikiLexical],
    gateByRelevance([...semantic, ...packs.semantic]),
    topK
  );
  // A what-to-do question: a pack section that says what to do (the preparedness pack's "During an earthquake") comes
  // right after the named articles, instead of competing in the fusion with keyword noise from the bundled corpus.
  const action = opts.action ?? ACTION_INTENT.test(query);
  // Up to three, so the named article and the other sources keep room.
  const steps = action
    ? wiki.flatMap((w) => w.hits.filter((h) => h.via !== "title" && h.action).map((h) => packHitToChunk(w.packId, h))).slice(0, 3)
    : [];
  // The user's own documents before everything else: a passage that passes their gate is what the question is about.
  const first = [...personalHits(lexical, semantic, PERSONAL_SLOTS), ...named, ...steps];
  const seen = new Set(first.map((c) => c.chunkId));
  // One copy per article passage across libraries (src/rag/dedupe.ts), before the cut, so a dropped
  // copy makes room for the next distinct source.
  const result = dedupeArticleCopies([
    ...first.filter((c, i) => first.findIndex((x) => x.chunkId === c.chunkId) === i),
    ...fused.filter((c) => !seen.has(c.chunkId)),
  ]).slice(0, Math.max(topK, named.length));
  // A what-to-do question: the lay sources the pack search added past its limit (a first-aid manual next to the
  // clinical article) must reach the answer, not be cut here with the rest of the keyword hits.
  if (action) {
    const inResult = new Set(result.map((c) => c.chunkId));
    const lay = wiki
      .flatMap((w) => w.hits.filter((h) => LAY_SOURCES.has(h.source)).map((h) => packHitToChunk(w.packId, h)))
      .filter((c) => !inResult.has(c.chunkId));
    // Through the same copy check as the rest (result is already one copy per passage, so it all stays).
    result.push(...dedupeArticleCopies([...result, ...lay]).slice(result.length, result.length + 2));
  }
  return result;
}

export { assemblePrompt } from "./pure";
export type { ConversationTurn, ConversationHistory } from "./pure";
