/**
 * The order of "Erase everything" (appReset.ts), pure so it's testable.
 *
 * The reset never closes an expo-sqlite connection. Closing one runs
 * sqlite3_finalize_all_statement on expo-sqlite's multi-threaded native
 * queue, and that crashed the app (SIGABRT, Scudo "corrupted chunk header",
 * Prism RS-1) even with every JS call awaited. Instead, stores are forgotten
 * (caches cleared, handles left alive), the shared database is emptied inside
 * its open connection, and files are unlinked: an open file can be deleted
 * on Android and iOS, and nothing reads it after the reset.
 *
 * Nothing is deleted while a download or a model context may still write or
 * map it. A failing step stops the reset.
 */
export interface ResetSteps {
  /** Stop running downloads and wait for their writers to settle. */
  cancelDownloads(): Promise<void>;
  /** Release the llama.cpp contexts, which keep model files mapped. */
  unloadEngines(): Promise<void>;
  /** Forget read-only stores (knowledge packs, places, gazetteer) without closing their connections. */
  forgetStores(): Promise<void>;
  /** Stop indexing and empty the shared database inside its open connection. */
  wipeDatabase(): Promise<void>;
  /** Delete downloaded and imported files (models, packs, places). */
  deleteFiles(): Promise<void>;
  /** Settings and other small JSON state. */
  clearSettings(): Promise<void>;
}

export const RESET_ORDER: ReadonlyArray<keyof ResetSteps> = [
  "cancelDownloads",
  "unloadEngines",
  "forgetStores",
  "wipeDatabase",
  "deleteFiles",
  "clearSettings",
];

export async function runReset(steps: ResetSteps): Promise<void> {
  for (const name of RESET_ORDER) await steps[name]();
}

/** "forget": drop a store's in-memory handles and caches. "wipe": empty a database in place. */
export type ResetPhase = "forget" | "wipe";
type Hook = () => Promise<void>;
const hooks: Record<ResetPhase, Map<string, Hook>> = { forget: new Map(), wipe: new Map() };

/**
 * Modules with their own SQLite state (src/rag: packs, places, the knowledge
 * base) register what the reset must do to them, so appReset doesn't import
 * them. Call at module load; the same phase and name replaces the earlier hook.
 */
export function registerResetHook(phase: ResetPhase, name: string, run: Hook): void {
  hooks[phase].set(name, run);
}

/**
 * Runs every hook of a phase. `required` names must be registered, or the
 * reset fails before deleting anything instead of silently skipping, say,
 * the chat history.
 */
export async function runResetHooks(phase: ResetPhase, required: string[] = []): Promise<void> {
  const missing = required.filter((name) => !hooks[phase].has(name));
  if (missing.length) throw new Error(`Reset step "${phase}" has no hook for: ${missing.join(", ")}`);
  await Promise.all([...hooks[phase].values()].map((run) => run()));
}
