import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { safePath } from "../storage/safePath";
import { fileRoots, type HandlerContext } from "./context";

// Same cap as the app's IMPORT_LIMITS["document-pdf"] (src/models/importLimits.ts), checked again here because main
// can't trust the renderer. Pages and time bound what a small but pathological PDF can cost.
const MAX_BYTES = 100 * 1000 ** 2;
const MAX_PAGES = 2000;
const TIMEOUT_MS = 2 * 60_000;

// pdf.js's packed character maps (CJK fonts), read from disk by the worker. Folder path; pdf.js wants a trailing "/" (fs reads it fine on Windows too).
const cMapUrl = path.join(path.dirname(createRequire(__filename).resolve("pdfjs-dist/package.json")), "cmaps") + "/";
// .ts under vitest, .js once compiled to dist/.
const workerFile = path.join(__dirname, "pdf-worker" + path.extname(__filename));

/**
 * Text of a PDF, in a worker thread killed after TIMEOUT_MS. Errors start with the native module's code
 * ("PASSWORD_REQUIRED: ...") because Electron IPC keeps only the message; the shim puts it back on `code`.
 */
export async function extractPdfText(file: string): Promise<string> {
  const { size } = await stat(file);
  if (size > MAX_BYTES) throw new Error(`TOO_LARGE: the PDF is ${Math.round(size / 1000 ** 2)} MB; the limit is ${MAX_BYTES / 1000 ** 2} MB`);
  const worker = new Worker(workerFile, { workerData: { file, maxPages: MAX_PAGES, cMapUrl } });
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`TIMEOUT: reading the PDF took over ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
      worker.once("message", (m: { text?: string; error?: string; code?: string }) => {
        clearTimeout(timer);
        if (m.error === undefined) resolve(m.text!);
        else reject(new Error(`${m.code}: ${m.error}`));
      });
      worker.once("error", (e: Error) => (clearTimeout(timer), reject(new Error(`UNKNOWN: ${e.message}`))));
      worker.once("exit", (c) => (clearTimeout(timer), reject(new Error(`UNKNOWN: PDF reader stopped (exit ${c})`))));
    });
  } finally {
    void worker.terminate();
  }
}

// Main-side handlers for the "expo-pdf-text-extract" shim.
export function register(ctx: HandlerContext): void {
  ctx.ipcMain.handle("expo-pdf-text-extract:extractText", (_e, uri: string) => extractPdfText(safePath(fileRoots(ctx), uri)));
}
