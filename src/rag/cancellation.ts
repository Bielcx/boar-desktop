/**
 * Long work on the knowledge base (indexing the bundled corpus, importing documents) registers here so a reset can
 * stop it before closing the database (RS-1). No native imports.
 */
import { DbClosedError } from "./guardedDb";

const controllers = new Set<AbortController>();

/** A signal for one piece of work: aborted by abortAllWork(), or when `external` (the caller's own) aborts. */
export function trackWork(external?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  controllers.add(c);
  const forward = () => c.abort();
  if (external?.aborted) c.abort();
  else external?.addEventListener("abort", forward);
  return {
    signal: c.signal,
    done: () => {
      controllers.delete(c);
      external?.removeEventListener("abort", forward);
    },
  };
}

/** Stops every piece of work in progress (the reset calls this first). */
export function abortAllWork(): void {
  for (const c of controllers) c.abort();
}

/** The error work sees when it was stopped by a reset: it should end quietly, not report a failure. */
export function isStopped(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || e instanceof DbClosedError;
}
