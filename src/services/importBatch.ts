/**
 * Several files picked together for import (Knowledge › Import), one at a time
 * since each is hashed in full. A file can be one the catalog doesn't know yet
 * because another file of the same pick registers it: a 1° tile is listed by
 * the gazetteer's tile index, so a tile checked before the gazetteer installs
 * failed as "unknown-file" (Piston, APK ecb83d3, step-042). So: the gazetteer
 * goes first when it is in the pick, and the files refused as unknown are
 * checked once more if anything was installed after they were refused.
 *
 * Pure (the import itself is passed in) so it runs under vitest.
 */
import { WORLD_PLACES } from "../rag/poiRegions";

const PLACES_FILE_NAME = WORLD_PLACES.filename.split("/").pop();

export type BatchResult<A> = { ok: true; asset: A } | { ok: false; error: unknown };

export async function importBatch<F extends { name: string }, A>(
  files: F[],
  importOne: (file: F) => Promise<A>,
  opts: {
    /** The refusal a later install can fix (the catalog didn't know the file). */
    isUnknown: (e: unknown) => boolean;
    /** Stop between files (user cancel); a skipped file gets no result. */
    aborted?: () => boolean;
    /** Awaited before the next file. */
    onResult: (file: F, result: BatchResult<A>) => unknown;
  }
): Promise<void> {
  // The gazetteer first: installing it registers the tiles picked with it.
  const ordered = [...files].sort((a, b) => Number(b.name === PLACES_FILE_NAME) - Number(a.name === PLACES_FILE_NAME));
  let installs = 0;
  const retry: Array<{ file: F; error: unknown; installsBefore: number }> = [];
  const attempt = async (file: F): Promise<BatchResult<A>> => {
    try {
      const asset = await importOne(file);
      installs++;
      return { ok: true, asset };
    } catch (error) {
      return { ok: false, error };
    }
  };
  for (const file of ordered) {
    if (opts.aborted?.()) return;
    const r = await attempt(file);
    if (!r.ok && opts.isUnknown(r.error)) retry.push({ file, error: r.error, installsBefore: installs });
    else await opts.onResult(file, r);
  }
  for (const { file, error, installsBefore } of retry) {
    if (opts.aborted?.()) return;
    // Nothing installed since it was refused: the catalog is the same, so is the answer.
    await opts.onResult(file, installs > installsBefore ? await attempt(file) : { ok: false, error });
  }
}
