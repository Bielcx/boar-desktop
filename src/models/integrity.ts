import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Pure integrity helpers (no Expo imports) so they run under vitest. The
 * platform glue that feeds them file bytes lives in fileHash.ts.
 */

export type IntegrityErrorKind =
  | "hash-mismatch"
  | "size-mismatch"
  | "unknown-file"
  /** The picked file really is 0 bytes (measured natively): copy it again. */
  | "empty-file"
  /** The picked file couldn't be opened or measured (gone, a folder, a provider that won't say its size). */
  | "unreadable-file"
  | "network"
  | "storage"
  | "offline-variant"
  | "too-large"
  | "no-source"
  | "cancelled"
  | "unknown";

/**
 * A download/import failure the UI can act on. `permanent` means retrying
 * the same source won't help (wrong bytes, wrong build variant, no space):
 * auto-retry must skip it, and the user needs another action (import a
 * file, free space, update the app).
 */
export class AssetIntegrityError extends Error {
  constructor(
    public readonly kind: IntegrityErrorKind,
    message: string,
    public readonly permanent: boolean
  ) {
    super(message);
    this.name = "AssetIntegrityError";
  }
}

/** Why a download stopped part-way, as a stable code the UI translates. */
export type DownloadErrorCode =
  /** The transfer failed (connection dropped, server error). The bytes so far are kept. */
  | "interrupted"
  /** No progress for `stallS` seconds; paused, and Retry resumes it. */
  | "paused";

/** The numbers behind a DownloadError, for a translated message in the UI. */
export interface DownloadErrorDetail {
  code: DownloadErrorCode;
  /** Bytes on disk when it stopped (the resume point). */
  bytesDone: number;
  bytesTotal: number;
  /** Seconds without progress before pausing ("paused" only). */
  stallS?: number;
}

/**
 * A download that stopped part-way and can be resumed (kind "network", never
 * permanent). `message` is English for logs and old callers; UIs should use
 * `detail`. The underlying exception text is logged, not put in the message.
 */
export class DownloadError extends AssetIntegrityError {
  constructor(
    public readonly detail: DownloadErrorDetail,
    message: string
  ) {
    super("network", message, false);
  }
}

export function downloadErrorDetailOf(e: unknown): DownloadErrorDetail | undefined {
  return e instanceof DownloadError ? e.detail : undefined;
}

/**
 * The user cancelled an import (AbortSignal). `name` is "AbortError", like
 * fetch's, so callers can check `e.name === "AbortError"` for any cancel.
 */
export class ImportAbortedError extends Error {
  constructor(message = "Import cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImportAbortedError();
}

export function errorKindOf(e: unknown): { kind: IntegrityErrorKind; permanent: boolean } {
  if (e instanceof AssetIntegrityError) return { kind: e.kind, permanent: e.permanent };
  if (isAbortError(e)) return { kind: "cancelled", permanent: false };
  return { kind: "unknown", permanent: false };
}

export function digestsEqual(expected: string, actual: string): boolean {
  return expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

/** Reads a file front to back; `read` returns an empty array at EOF. */
export interface ChunkReader {
  read(maxBytes: number): Uint8Array | Promise<Uint8Array>;
  close(): void;
}

export interface ChunkedHashOptions {
  chunkBytes?: number;
  totalBytes?: number;
  onProgress?: (bytesHashed: number, totalBytes: number) => void;
  /** Called between chunks so a JS-thread hash can let the UI breathe. */
  yieldBetweenChunks?: () => Promise<void>;
  /** Checked between chunks; aborting rejects with ImportAbortedError. */
  signal?: AbortSignal;
}

/**
 * Incremental SHA-256 over a chunked reader: memory stays at one chunk no
 * matter how large the file is. Used as the fallback when the native
 * FileHash module isn't available (iOS for now, old builds).
 */
export async function sha256Chunked(reader: ChunkReader, opts: ChunkedHashOptions = {}): Promise<string> {
  const chunkBytes = opts.chunkBytes ?? 4 * 1024 * 1024;
  const total = opts.totalBytes ?? -1;
  const h = sha256.create();
  let done = 0;
  try {
    for (;;) {
      throwIfAborted(opts.signal);
      const chunk = await reader.read(chunkBytes);
      if (chunk.length === 0) break;
      h.update(chunk);
      done += chunk.length;
      opts.onProgress?.(done, total);
      if (opts.yieldBetweenChunks) await opts.yieldBetweenChunks();
    }
  } finally {
    reader.close();
  }
  return bytesToHex(h.digest());
}

export interface CatalogFingerprint {
  id: string;
  sizeBytes: number;
  sha256: string;
}

/** Catalog entries a file of this size could be. Nothing else is worth hashing for. */
export function candidatesBySize<T extends CatalogFingerprint>(catalog: T[], sizeBytes: number): T[] {
  return catalog.filter((a) => a.sizeBytes === sizeBytes);
}

/** The catalog entry whose size and sha256 both match, or null. */
export function matchByDigest<T extends CatalogFingerprint>(candidates: T[], sizeBytes: number, digest: string): T | null {
  return candidates.find((a) => a.sizeBytes === sizeBytes && digestsEqual(a.sha256, digest)) ?? null;
}
