import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, statfs, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileRoots, type HandlerContext } from "./context";
import { safePath } from "../storage/safePath";

/** Payload of "expo-file-system-legacy:downloadProgress" events, sent with the download id. */
export interface DownloadProgressData {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
}

type Encoding = "utf8" | "base64";
const PROGRESS_EVERY_MS = 100;

// ponytail: tests point downloads at a local http server; the app itself only ever gets https.
const httpAllowed = () => process.env.BOAR_ALLOW_HTTP_DOWNLOADS === "1";
const MAX_REDIRECTS = 10;

function checkUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && httpAllowed())) throw new Error(`only https downloads are allowed: ${u.protocol}//${u.host}`);
  return u;
}

/** GET following redirects by hand (fetch's own would follow https -> http), each hop checked by checkUrl. */
async function get(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  for (let hop = 0; ; hop++) {
    const res = await fetch(checkUrl(url), { headers, signal, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location) return res;
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects for ${url}`);
    url = new URL(location, url).href;
  }
}

/**
 * Main side of expo-file-system/legacy: plain fs/promises on paths checked by safePath, plus downloads (fetch streamed
 * to disk, resumable with a Range request). Channel names: "expo-file-system-legacy:<method>".
 */
export function register(ctx: HandlerContext): void {
  const path = (uri: unknown) => safePath(fileRoots(ctx), uri);
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ctx.ipcMain.handle(`expo-file-system-legacy:${name}`, (_e, ...args) => fn(...args));

  handle("getInfoAsync", async (uri: string) => {
    const s = await stat(path(uri)).catch(() => null);
    if (!s) return { exists: false, uri, isDirectory: false };
    return { exists: true, uri, size: s.size, isDirectory: s.isDirectory(), modificationTime: s.mtimeMs / 1000 };
  });
  handle("readAsStringAsync", async (uri: string, opts?: { encoding?: Encoding }) =>
    (await readFile(path(uri))).toString(opts?.encoding === "base64" ? "base64" : "utf8")
  );
  handle("writeAsStringAsync", async (uri: string, text: string, opts?: { encoding?: Encoding }) => {
    await writeFile(path(uri), Buffer.from(String(text), opts?.encoding === "base64" ? "base64" : "utf8"));
  });
  handle("deleteAsync", async (uri: string, opts?: { idempotent?: boolean }) => {
    await rm(path(uri), { recursive: true, force: !!opts?.idempotent });
  });
  handle("makeDirectoryAsync", async (uri: string, opts?: { intermediates?: boolean }) => {
    await mkdir(path(uri), { recursive: !!opts?.intermediates });
  });
  handle("readDirectoryAsync", (uri: string) => readdir(path(uri)));
  handle("moveAsync", async (o: { from: string; to: string }) => {
    await rename(path(o?.from), path(o?.to));
  });
  handle("copyAsync", async (o: { from: string; to: string }) => {
    await cp(path(o?.from), path(o?.to), { recursive: true });
  });
  handle("getFreeDiskStorageAsync", async () => {
    const s = await statfs(ctx.roots.document);
    return s.bavail * s.bsize;
  });

  const downloads = new Map<string, { abort: AbortController; done: Promise<unknown> }>();

  /**
   * Downloads url to fileUri, resolving with expo's FileSystemDownloadResult, or null when paused. With `resumeFrom`
   * (expo's resumeData: a byte offset) the file keeps its first N bytes and the rest is requested with
   * "Range: bytes=N-"; a server that ignores Range (200) restarts the file from zero, and a 416 whose total
   * ("Content-Range: bytes *\/N") is what's on disk means the file was already complete. Progress goes out as
   * ("expo-file-system-legacy:downloadProgress", id, {totalBytesWritten, totalBytesExpectedToWrite}), at most every
   * 100 ms plus once at the end; totals include the resumed bytes, like the Android downloader.
   * Redirects are followed by hand so every hop must be https too. `headers` is ignored: the app sends none
   * (ModelManager.ts), and forwarding arbitrary ones from the renderer would only widen what a page can make main send.
   */
  handle("downloadAsync", async (id: string, url: string, fileUri: string, _headers?: Record<string, string>, resumeFrom?: string) => {
    if (downloads.has(id)) throw new Error(`download ${id} is already running`);
    checkUrl(url);
    const dest = path(fileUri);
    const abort = new AbortController();
    const run = (async () => {
      const onDisk = (await stat(dest).catch(() => null))?.size ?? 0;
      let offset = Math.min(resumeFrom === undefined ? onDisk : Number(resumeFrom) || 0, onDisk);
      const res = await get(url, offset > 0 ? { Range: `bytes=${offset}-` } : {}, abort.signal);
      const result = (status: number) => ({
        uri: fileUri,
        status,
        headers: Object.fromEntries(res.headers),
        mimeType: res.headers.get("content-type"),
      });
      if (res.status === 416 && offset > 0 && res.headers.get("content-range") === `bytes */${onDisk}`) {
        await res.body?.cancel();
        ctx.send("expo-file-system-legacy:downloadProgress", id, { totalBytesWritten: onDisk, totalBytesExpectedToWrite: onDisk });
        return result(200);
      }
      // An error status leaves the file as it was (a partial download stays resumable). No body in the message:
      // it's the server's text, not ours.
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      if (offset > 0 && res.status !== 206) offset = 0;
      const length = Number(res.headers.get("content-length") ?? -1);
      const total = length >= 0 ? offset + length : -1;
      await mkdir(dirname(dest), { recursive: true });
      if (offset > 0) await truncate(dest, offset);
      let written = offset;
      let lastSent = 0;
      const progress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastSent < PROGRESS_EVERY_MS) return;
        lastSent = now;
        ctx.send("expo-file-system-legacy:downloadProgress", id, { totalBytesWritten: written, totalBytesExpectedToWrite: total });
      };
      progress(true);
      // pipeline: a write error (disk full, bad destination) or a dropped connection rejects here instead of
      // crashing main or hanging on 'drain'; the bytes already written stay on disk for a resume.
      await pipeline(
        res.body ? Readable.fromWeb(res.body as any) : Readable.from([]),
        new Transform({
          transform(chunk: Buffer, _enc, done) {
            written += chunk.length;
            progress();
            done(null, chunk);
          },
        }),
        createWriteStream(dest, { flags: offset > 0 ? "a" : "w" })
      );
      progress(true);
      return result(res.status);
    })();
    downloads.set(id, { abort, done: run.catch(() => {}) });
    try {
      return await run;
    } catch (e) {
      if (abort.signal.aborted) return null;
      throw e;
    } finally {
      downloads.delete(id);
    }
  });

  /** Stops a running download, keeping its bytes; resolves with the resumeData (bytes on disk) once it has stopped. */
  handle("pauseDownload", async (id: string, fileUri: string) => {
    const d = downloads.get(id);
    d?.abort.abort();
    await d?.done;
    return String((await stat(path(fileUri)).catch(() => null))?.size ?? 0);
  });
}
