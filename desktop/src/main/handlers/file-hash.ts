import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { fileRoots, type HandlerContext } from "./context";
import { safePath } from "../storage/safePath";

const PROGRESS_EVERY_MS = 100;

/** Rejected jobs carry this in the message too: Electron IPC keeps only an error's message, and the shim restores `code`. */
class Cancelled extends Error {
  code = "E_CANCELLED";
  constructor() {
    super("E_CANCELLED: hashing cancelled");
  }
}

/**
 * Main side of modules/file-hash: streaming SHA-256 (optionally copying while hashing), progress as
 * ("file-hash:onProgress", {jobId, bytesHashed, totalBytes}) at most every 100 ms plus once at the end, and cancel by job id.
 */
export function register(ctx: HandlerContext): void {
  const path = (uri: unknown) => safePath(fileRoots(ctx), uri);
  const cancelled = new Set<string>();

  async function hash(jobId: string, src: string, dest?: string): Promise<{ sha256: string; bytes: number }> {
    const totalBytes = (await stat(src)).size;
    const h = createHash("sha256");
    const out = dest ? createWriteStream(dest) : null;
    let bytesHashed = 0;
    let lastSent = 0;
    const progress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSent < PROGRESS_EVERY_MS) return;
      lastSent = now;
      ctx.send("file-hash:onProgress", { jobId, bytesHashed, totalBytes });
    };
    try {
      for await (const chunk of createReadStream(src, { highWaterMark: 4 * 1024 * 1024 })) {
        if (cancelled.has(jobId)) throw new Cancelled();
        h.update(chunk as Buffer);
        if (out && !out.write(chunk)) await new Promise((r) => out.once("drain", r));
        bytesHashed += (chunk as Buffer).length;
        progress();
      }
      if (out) {
        out.end();
        await finished(out);
      }
      progress(true);
      return { sha256: h.digest("hex"), bytes: bytesHashed };
    } catch (e) {
      if (out) {
        out.destroy();
        await rm(dest!, { force: true });
      }
      throw e;
    } finally {
      cancelled.delete(jobId);
    }
  }

  ctx.ipcMain.handle("file-hash:sha256", async (_e, uri: string, jobId: string) => (await hash(String(jobId), path(uri))).sha256);
  ctx.ipcMain.handle("file-hash:copyWithSha256", (_e, src: string, dest: string, jobId: string) =>
    hash(String(jobId), path(src), path(dest))
  );
  ctx.ipcMain.handle("file-hash:size", async (_e, uri: string) => (await stat(path(uri)).catch(() => null))?.size ?? -1);
  ctx.ipcMain.handle("file-hash:cancel", (_e, jobId: string) => void cancelled.add(String(jobId)));
}
