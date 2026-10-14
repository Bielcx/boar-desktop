// worker_threads entry for expo-pdf-text-extract.ts: parses one PDF with pdf.js off the main event loop, so a big or
// hostile PDF can't freeze the window and the handler can kill it on timeout. Posts {text} or {error, code}.
import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

const { file, maxPages, cMapUrl } = workerData as { file: string; maxPages: number; cMapUrl: string };

async function extract(): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js runs its parser in this same thread when it finds the worker module here (no nested worker, no URL lookup).
  // @ts-expect-error: pdf.js ships no types for its worker module.
  (globalThis as any).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const data = new Uint8Array(await readFile(file));
  // This thread has Node's full access and the PDF may be hostile (a watched folder imports whatever lands there): no
  // font loading and no system fonts, which text extraction doesn't need. (pdf.js 6 has no eval path for fonts any
  // more, the route of CVE-2024-4367.)
  const task = pdfjs.getDocument({ data, cMapUrl, cMapPacked: true, verbosity: 0, disableFontFace: true, useSystemFonts: false });
  try {
    const doc = await task.promise;
    if (doc.numPages > maxPages) throw Object.assign(new Error(`it has ${doc.numPages} pages; the limit is ${maxPages}`), { code: "TOO_LARGE" });
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      let text = "";
      for (const item of (await page.getTextContent()).items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      pages.push(text.trimEnd());
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}

extract().then(
  (text) => parentPort!.postMessage({ text }),
  (e: any) => {
    // Same codes as the native module (expo-pdf-text-extract's PdfErrorCode); pdf.js's PasswordException code 1 = need, 2 = wrong.
    const code =
      e?.code === "TOO_LARGE" ? "TOO_LARGE"
      : e?.name === "PasswordException" ? (e.code === 2 ? "INCORRECT_PASSWORD" : "PASSWORD_REQUIRED")
      : e?.name === "InvalidPDFException" || e?.name === "FormatError" ? "CORRUPT_PDF"
      : "UNKNOWN";
    parentPort!.postMessage({ error: String(e?.message ?? e), code });
  }
);
