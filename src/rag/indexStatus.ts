/**
 * Index state per knowledge-base collection, shared by the seed corpus
 * (src/rag/seedCorpus.ts: "builtin" and downloaded JSON packs) and
 * user-imported collections (src/services/documentImporter.ts: "custom-…" ids),
 * so the Knowledge screen reads one map. No native imports.
 */

export type CollectionIndexState = "indexed" | "indexing" | "error";

export interface CollectionIndexStatus {
  state: CollectionIndexState;
  /** Documents (seed corpus) or chunks (imports) done so far in the current or last run. */
  done: number;
  total: number;
  error?: string;
}

// On globalThis rather than in the module: a dev hot reload re-runs this
// module while an indexing run is still going.
const g = globalThis as {
  __boarSeedStatus?: Map<string, CollectionIndexStatus>;
  __boarSeedStatusListeners?: Set<(s: Record<string, CollectionIndexStatus>) => void>;
};
const status = (g.__boarSeedStatus ??= new Map());
const listeners = (g.__boarSeedStatusListeners ??= new Set());

/**
 * Index state of each collection seen in this app session, keyed by
 * collection id. A collection that isn't listed hasn't been (re)indexed in
 * this session, or was removed, or its import was cancelled.
 */
export function getCollectionIndexStatus(): Record<string, CollectionIndexStatus> {
  return Object.fromEntries(status);
}

/** Called with the whole map whenever a collection's state changes. Returns an unsubscribe. */
export function onCollectionIndexStatus(listener: (s: Record<string, CollectionIndexStatus>) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  const snapshot = getCollectionIndexStatus();
  listeners.forEach((l) => l(snapshot));
}

export function setCollectionIndexStatus(id: string, next: CollectionIndexStatus): void {
  status.set(id, next);
  notify();
}

/** Forgets a collection's state (removed, cancelled, or an error the user dismissed). */
export function clearCollectionIndexStatus(id: string): void {
  if (status.delete(id)) notify();
}
