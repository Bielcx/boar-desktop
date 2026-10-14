import * as FileSystem from "expo-file-system/legacy";
import { getDb, insertChunk, deleteSeedChunks, deleteSeedChunksWithPrefix, ChunkRecord } from "./db";
import { closePack } from "./packs";
import { clearCollectionIndexStatus, setCollectionIndexStatus } from "./indexStatus";

export {
  getCollectionIndexStatus,
  onCollectionIndexStatus,
  type CollectionIndexState,
  type CollectionIndexStatus,
} from "./indexStatus";
import { embeddingEngine } from "./embed";
import minimumCorpus from "../../assets/corpus/corpus.json";
import { CORPUS_CATALOG, CatalogModel } from "../models/manifest";
import { isStopped, trackWork } from "./cancellation";

/**
 * Knowledge base sources, layered:
 *
 * 1. minimumCorpus (assets/corpus/corpus.json) — 300 Wikipedia article
 *    introductions, bundled directly in the JS bundle, always present, no
 *    download needed.
 * 2. Downloaded corpus packs (CORPUS_CATALOG entries, "standard"/"full"
 *    tiers) — read from disk if the user downloaded them via Settings or
 *    the first-run tier picker; skipped if not present.
 *
 * Called on every app start; each doc has a stable id so re-running only
 * inserts docs that aren't already in the DB (embedding is the expensive
 * part, so this avoids re-embedding everything just because a new corpus
 * pack was added later). Embeddings are computed on-device (not
 * precomputed at build/download time) so the vector index always matches
 * whatever embedding model actually ships.
 */
type SeedDoc = { id: string; title: string; source: string; body: string };

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Ids of seed docs that earlier versions installed and this one no longer
 * ships. They're deleted from existing installs on the next seed run.
 *
 * The app-* ids were five hand-written notes (MoE and RAM, mmap streaming,
 * BM25 vs cosine, GrapheneOS, RAM budgeting) that answered the eval's own
 * reasoning questions, which inflated its retrieval results. Only text taken
 * from a citable source belongs in the knowledge base.
 */
export const RETIRED_SEED_IDS = [
  "app-moe-ram",
  "app-mmap-streaming",
  "app-bm25-vs-cosine",
  "app-grapheneos",
  "app-ram-budgeting",
];

/** Collection id of the corpus bundled in the app; downloaded JSON packs use their catalog id. */
export const BUILTIN_COLLECTION_ID = "builtin";

type SeedCollection = { id: string; docs: SeedDoc[]; error?: string };

/** Seed-corpus chunk ids are `wiki-<collection>-<title slug>`; "min" is the bundled corpus. */
function chunkIdPrefix(collectionId: string): string {
  return `wiki-${collectionId === BUILTIN_COLLECTION_ID ? "min" : collectionId}-`;
}

/** First doc wins when two titles share a slug, so a collection's size matches what gets indexed. */
function toSeedDocs(collectionId: string, docs: Array<{ title: string; source: string; body: string }>): SeedDoc[] {
  const byId = new Map<string, SeedDoc>();
  for (const d of docs) {
    const id = `${chunkIdPrefix(collectionId)}${slug(d.title)}`;
    if (!byId.has(id)) byId.set(id, { ...d, id });
  }
  return [...byId.values()];
}

const MINIMUM_CORPUS_DOCS: SeedDoc[] = toSeedDocs(
  BUILTIN_COLLECTION_ID,
  minimumCorpus as Array<{ title: string; source: string; body: string }>
);

async function loadDownloadedCorpusPacks(): Promise<SeedCollection[]> {
  const collections: SeedCollection[] = [];
  for (const pack of CORPUS_CATALOG) {
    if (pack.format === "sqlite-pack") continue;
    const path = `${FileSystem.documentDirectory}${pack.filename}`;
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) continue;
    try {
      const raw = await FileSystem.readAsStringAsync(path);
      collections.push({ id: pack.id, docs: toSeedDocs(pack.id, JSON.parse(raw)) });
    } catch (e: any) {
      console.warn(`Failed to load corpus pack ${pack.id}:`, e);
      collections.push({ id: pack.id, docs: [], error: String(e?.message ?? e) });
    }
  }
  return collections;
}

export interface SeedProgress {
  /** Documents checked so far across all collections, including ones already indexed. */
  done: number;
  total: number;
  /** Title of the document being indexed. */
  title: string;
  /** The collection being indexed: BUILTIN_COLLECTION_ID or a corpus pack's catalog id. */
  collectionId: string;
  collectionDone: number;
  collectionTotal: number;
}

// On globalThis rather than in the module: a dev hot reload re-runs this
// module while the previous run is still inserting.
const running = globalThis as {
  __boarSeeding?: Promise<void> | null;
  __boarSeedListeners?: Set<(p: SeedProgress) => void>;
};
const listeners = (running.__boarSeedListeners ??= new Set());

/** Progress of the indexing run in progress, for a status line. Returns an unsubscribe. */
export function onSeedProgress(listener: (p: SeedProgress) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const setStatus = setCollectionIndexStatus;

/**
 * Removes a downloaded corpus pack from the knowledge base, before its file
 * is deleted: a JSON pack's indexed chunks are deleted (otherwise they keep
 * showing up in answers), and a SQLite pack's open connection is closed.
 * Returns how many chunks were deleted.
 */
export async function removeCorpusPackIndex(pack: Pick<CatalogModel, "id" | "format">): Promise<number> {
  if (pack.format === "sqlite-pack") {
    await closePack(pack.id);
    return 0;
  }
  if (pack.id === BUILTIN_COLLECTION_ID) return 0;
  // Let a run in progress finish first, or it would re-insert what's deleted here.
  await running.__boarSeeding?.catch(() => {});
  const removed = await deleteSeedChunksWithPrefix(chunkIdPrefix(pack.id));
  clearCollectionIndexStatus(pack.id);
  return removed;
}

/**
 * The setup wizard and the chat screen can both ask for this at once (and a
 * dev reload can repeat it), so concurrent callers share one run instead of
 * inserting the same documents twice.
 */
export function seedKnowledgeBaseIfEmpty(): Promise<void> {
  running.__boarSeeding ??= seedStoppable().finally(() => {
    running.__boarSeeding = null;
  });
  return running.__boarSeeding;
}

/** seedNow, stopped quietly by a reset (RS-1): no "error" state, no rejection for the caller to show. */
async function seedStoppable(): Promise<void> {
  const work = trackWork();
  try {
    await seedNow(work.signal);
  } catch (e) {
    if (!(e instanceof SeedStopped) && !isStopped(e, work.signal)) throw e;
  } finally {
    work.done();
  }
}

class SeedStopped extends Error {}

async function seedNow(signal: AbortSignal): Promise<void> {
  const db = await getDb();
  await deleteSeedChunks(RETIRED_SEED_IDS);
  const collections: SeedCollection[] = [
    { id: BUILTIN_COLLECTION_ID, docs: MINIMUM_CORPUS_DOCS },
    ...(await loadDownloadedCorpusPacks()),
  ];
  const total = collections.reduce((n, c) => n + c.docs.length, 0);
  for (const c of collections) {
    if (c.error) setStatus(c.id, { state: "error", done: 0, total: 0, error: c.error });
  }

  // This runs on every ChatScreen mount — including every time Settings
  // closes and the user returns to chat, not just on first app launch —
  // so the common case (nothing new to seed) needs to be cheap. Without
  // this, the per-doc existence check below still runs in full every
  // time: up to 5,300+ sequential SELECT queries on the "full" corpus
  // tier, during which the chat input is disabled (see ChatScreen.tsx's
  // `ready` state), even though almost always nothing actually changed.
  // A single COUNT(*) lets the fully-seeded case skip straight past the
  // loop; any mismatch (a newly downloaded corpus pack, a fresh install)
  // falls through to the real per-doc check, same as before.
  // collection_id IS NULL scopes this to seed-corpus-managed rows only —
  // user-imported documents (src/ui/PersonalDocumentsManager.tsx) live in
  // the same `chunks` table with a non-null collection_id, and counting
  // those too would make this check permanently mismatch (always fall
  // through to the full loop) for anyone who's imported personal docs.
  const { count } = (await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM chunks WHERE collection_id IS NULL`
  )) ?? { count: 0 };
  if (count === total) {
    for (const c of collections) {
      if (!c.error) setStatus(c.id, { state: "indexed", done: c.docs.length, total: c.docs.length });
    }
    return;
  }

  let lastReport = 0;
  let done = 0;
  for (const c of collections) {
    if (c.error) continue;
    setStatus(c.id, { state: "indexing", done: 0, total: c.docs.length });
    try {
      for (const [i, doc] of c.docs.entries()) {
        if (signal.aborted) throw new SeedStopped();
        done++;
        // About four updates a second is enough to show it's moving.
        const now = Date.now();
        if (now - lastReport > 250 || done === total) {
          lastReport = now;
          const p: SeedProgress = {
            done,
            total,
            title: doc.title,
            collectionId: c.id,
            collectionDone: i + 1,
            collectionTotal: c.docs.length,
          };
          listeners.forEach((l) => l(p));
        }

        const existing = await db.getFirstAsync<{ chunk_id: string }>(
          `SELECT chunk_id FROM chunks WHERE chunk_id = ?`,
          [doc.id]
        );
        if (existing) continue;

        const chunk: ChunkRecord = {
          chunkId: doc.id,
          docId: doc.id,
          title: doc.title,
          body: doc.body,
          source: doc.source,
        };
        const embedding = await embeddingEngine.embed(`${doc.title}\n${doc.body}`);
        await insertChunk(chunk, embedding);
      }
      setStatus(c.id, { state: "indexed", done: c.docs.length, total: c.docs.length });
    } catch (e: any) {
      if (e instanceof SeedStopped || isStopped(e, signal)) {
        clearCollectionIndexStatus(c.id);
        throw e;
      }
      setStatus(c.id, { state: "error", done: 0, total: c.docs.length, error: String(e?.message ?? e) });
      throw e;
    }
  }
}
