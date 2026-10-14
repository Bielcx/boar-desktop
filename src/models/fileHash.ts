import { File } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import { FileHashNative } from "file-hash";
import { ImportAbortedError, sha256Chunked, throwIfAborted } from "./integrity";

export type HashProgress = (bytesHashed: number, totalBytes: number) => void;

let jobCounter = 0;
const nextJobId = () => `hash-${Date.now()}-${++jobCounter}`;

async function runNative<T>(
  onProgress: HashProgress | undefined,
  signal: AbortSignal | undefined,
  run: (jobId: string) => Promise<T>
): Promise<T> {
  throwIfAborted(signal);
  const jobId = nextJobId();
  const sub = onProgress
    ? FileHashNative!.addListener("onProgress", (e) => {
        if (e.jobId === jobId) onProgress(e.bytesHashed, e.totalBytes);
      })
    : null;
  const onAbort = () => FileHashNative!.cancel?.(jobId);
  signal?.addEventListener("abort", onAbort);
  try {
    return await run(jobId);
  } catch (e: any) {
    if (e?.code === "E_CANCELLED" || signal?.aborted) throw new ImportAbortedError();
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    sub?.remove();
  }
}

/** JS fallback: reads 4 MiB at a time and yields between chunks. Slower, same memory profile. */
async function sha256InJs(uri: string, onProgress?: HashProgress, signal?: AbortSignal): Promise<string> {
  const file = new File(uri);
  const handle = file.open();
  return sha256Chunked(
    { read: (n) => handle.readBytes(n), close: () => handle.close() },
    { totalBytes: file.size ?? -1, onProgress, signal, yieldBetweenChunks: () => new Promise((r) => setTimeout(r, 0)) }
  );
}

/** What sizeOfFile learned about a file: its size, that it's really empty, or that it couldn't be measured. */
export type FileMeasure = { kind: "size"; bytes: number } | { kind: "empty" } | { kind: "unreadable" };

/**
 * Measures a file:// or content:// URI. expo-file-system's legacy
 * getInfoAsync measures content:// with an Int (InputStream.available()), so
 * a picked file over 2 GB read as 0 bytes and was refused (IMP-2GB). The
 * native module measures a Long (file descriptor length, then the provider's
 * OpenableColumns.SIZE); the legacy call is only the fallback for builds
 * without it. Only the native size can say "empty": a 0 from the legacy call
 * is what the overflow looked like, so it counts as unreadable.
 */
export async function measureFile(uri: string): Promise<FileMeasure> {
  const native = FileHashNative?.size ? await FileHashNative.size(uri).catch(() => -1) : -1;
  if (native > 0) return { kind: "size", bytes: native };
  if (native === 0) return { kind: "empty" };
  const info = await FileSystem.getInfoAsync(uri).catch(() => null);
  if (!info?.exists || info.isDirectory) return { kind: "unreadable" };
  return info.size && info.size > 0 ? { kind: "size", bytes: info.size } : { kind: "unreadable" };
}

/** The size in bytes, or null if the file is empty or couldn't be measured (never 0). */
export async function sizeOfFile(uri: string): Promise<number | null> {
  const m = await measureFile(uri);
  return m.kind === "size" ? m.bytes : null;
}

/** Streaming SHA-256 (lowercase hex) of a file:// or content:// URI. Never loads the whole file. */
export async function sha256OfFile(uri: string, onProgress?: HashProgress, signal?: AbortSignal): Promise<string> {
  if (FileHashNative) return runNative(onProgress, signal, (jobId) => FileHashNative!.sha256(uri, jobId));
  return sha256InJs(uri, onProgress, signal);
}

/**
 * Copies srcUri to destUri and returns the SHA-256 of what was written.
 * Aborting `signal` stops it and rejects with ImportAbortedError (name
 * "AbortError"); the caller deletes the partial copy. The
 * native module does both in one pass; the fallback copies, then hashes the
 * copy (the copy is what gets used, so that's the bytes that matter).
 */
export async function copyWithSha256(
  srcUri: string,
  destUri: string,
  onProgress?: HashProgress,
  signal?: AbortSignal
): Promise<{ sha256: string; bytes: number }> {
  if (FileHashNative) {
    return runNative(onProgress, signal, (jobId) => FileHashNative!.copyWithSha256(srcUri, destUri, jobId));
  }
  // The fallback copy itself can't be interrupted; the abort lands right after it.
  throwIfAborted(signal);
  await FileSystem.copyAsync({ from: srcUri, to: destUri });
  throwIfAborted(signal);
  const info = await FileSystem.getInfoAsync(destUri);
  const sha256 = await sha256InJs(destUri, onProgress, signal);
  return { sha256, bytes: info.exists ? info.size ?? 0 : 0 };
}
