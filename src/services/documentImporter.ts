import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { extractText as extractPdfText } from "expo-pdf-text-extract";
import { embeddingEngine } from "../rag/embed";
import {
  insertChunk,
  createCustomCollection,
  deleteCustomCollection,
  setCustomCollectionActive,
  listCustomCollections,
  getCollectionDocs,
  CustomCollection,
  deleteCollectionChunks,
  refreshCollectionSummary,
} from "../rag/db";
import { clearCollectionIndexStatus, setCollectionIndexStatus } from "../rag/indexStatus";
import { checkImportSize, importKindOfDocument } from "../models/importLimits";
import { discardPickerCopies } from "./pickerCache";
import { isStopped, trackWork } from "../rag/cancellation";

/**
 * User-supplied document import for the local knowledge base (Settings >
 * Knowledge Base > Import Documents). Formats:
 *
 * - .txt / .md: read as plain text.
 * - .csv: naive comma-split per line (no quoted-field escaping) — fine for
 *   simple exports, not a full CSV parser.
 * - .json: if it matches the same {title, source, body}[] shape used by the
 *   app's own downloadable corpus packs (assets/corpus/*.json), each entry
 *   is imported as its own doc; otherwise the whole file is chunked as text.
 * - .pdf: embedded/selectable text only, via expo-pdf-text-extract (Apache
 *   PDFBox-Android on-device, no network, no OCR). Scanned/image-only PDFs
 *   extract to empty text — there's no OCR step. Password-protected PDFs
 *   are rejected with a clear error rather than attempted.
 */

const CHARS_PER_TOKEN = 4; // rough English-text heuristic, no tokenizer on-device
const CHUNK_CHARS = 500 * CHARS_PER_TOKEN;
const OVERLAP_CHARS = 50 * CHARS_PER_TOKEN;

export const SUPPORTED_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
];

/** Thrown by importDocuments when its signal aborts; the import leaves nothing behind. */
export class ImportCancelledError extends Error {
  name = "AbortError";
  constructor() {
    super("Import cancelled");
  }
}

export interface ImportProgress {
  stage: "reading" | "chunking" | "embedding";
  chunkIndex?: number;
  chunkCount?: number;
}

function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= CHUNK_CHARS) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + CHUNK_CHARS, trimmed.length);
    chunks.push(trimmed.slice(start, end));
    if (end >= trimmed.length) break;
    start = end - OVERLAP_CHARS;
  }
  return chunks;
}

function csvToText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(",").join(" | "))
    .join("\n");
}

type ParsedDoc = { title: string; source: string; body: string };

/**
 * PDFs are binary — reading them with readAsStringAsync (used for every
 * other format) would just return garbage, so extraction has its own path
 * via the native module rather than going through the raw-text branches
 * below. Password-protected PDFs surface a clear message instead of the
 * native module's raw PASSWORD_REQUIRED/INCORRECT_PASSWORD error code —
 * this importer has no password-prompt UI, so there's nothing useful to do
 * with an encrypted PDF beyond telling the user why it was skipped.
 */
async function extractPdf(uri: string, filename: string): Promise<string> {
  try {
    return await extractPdfText(uri);
  } catch (e: any) {
    if (e?.code === "PASSWORD_REQUIRED" || e?.code === "INCORRECT_PASSWORD") {
      throw new Error(`"${filename}" is password-protected — password-protected PDFs aren't supported.`);
    }
    throw new Error(`Couldn't read "${filename}": ${e?.message ?? e}`);
  }
}

async function parseFileContent(
  file: DocumentPicker.DocumentPickerAsset,
  fallbackTitle: string
): Promise<ParsedDoc[]> {
  const filename = file.name;
  const ext = filename.toLowerCase().split(".").pop();
  // Documents are read whole into memory: refuse oversized ones before reading.
  const size = checkImportSize(importKindOfDocument(filename), file.size ?? 0);
  if (!size.ok) throw new Error(size.message);

  if (ext === "pdf") {
    const text = await extractPdf(file.uri, filename);
    return [{ title: fallbackTitle, source: filename, body: text }];
  }

  const raw = await FileSystem.readAsStringAsync(file.uri);

  if (ext === "json") {
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every((d) => typeof d?.title === "string" && typeof d?.body === "string")
      ) {
        return parsed.map((d) => ({
          title: d.title,
          source: typeof d.source === "string" ? d.source : filename,
          body: d.body,
        }));
      }
    } catch {
      // not valid JSON, or not the corpus-pack shape — fall through to plain text
    }
    return [{ title: fallbackTitle, source: filename, body: raw }];
  }

  if (ext === "csv") {
    return [{ title: fallbackTitle, source: filename, body: csvToText(raw) }];
  }

  // .md / .txt / anything else we let through the picker filter
  return [{ title: fallbackTitle, source: filename, body: raw }];
}

type Chunk = { chunkId: string; docId: string; title: string; body: string; source: string };

/** Ids start with `idPrefix` (the collection, or one watched file in it), so they can be deleted as a group. */
function toChunks(docs: ParsedDoc[], idPrefix: string): Chunk[] {
  const chunks: Chunk[] = [];
  docs.forEach((doc, docIndex) => {
    const docId = `${idPrefix}-doc${docIndex}-${slug(doc.title)}`;
    const pieces = chunkText(doc.body);
    pieces.forEach((body, i) => {
      chunks.push({
        chunkId: `${docId}-c${i}`,
        docId,
        title: pieces.length > 1 ? `${doc.title} (part ${i + 1}/${pieces.length})` : doc.title,
        body,
        source: doc.source,
      });
    });
  });
  return chunks;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

export async function pickDocuments(): Promise<DocumentPicker.DocumentPickerAsset[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: SUPPORTED_MIME_TYPES,
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  return result.assets;
}

/**
 * Imports one or more already-picked files as a single named collection:
 * reads each file, splits into docs (see parseFileContent), chunks each doc,
 * embeds every chunk on-device (sequentially — the shared llama.cpp
 * embedding context can't run concurrent embeddings), and inserts into the
 * FTS5 + vector tables tagged with this collection's id so it can be
 * toggled or deleted as a unit later.
 *
 * The collection row is created before its chunks, so a failed or cancelled
 * import can always be removed as a unit (no orphaned chunks). Its state is
 * published in the shared collection index status (src/rag/indexStatus.ts):
 * "indexing" with chunk counts, then "indexed", or "error". Aborting
 * `signal` deletes everything inserted so far, clears the state (as if the
 * import never started) and rejects with ImportCancelledError.
 */
export async function importDocuments(
  files: DocumentPicker.DocumentPickerAsset[],
  collectionName: string,
  onProgress?: (p: ImportProgress) => void,
  signal?: AbortSignal
): Promise<CustomCollection> {
  const collectionId = `custom-${Date.now()}-${slug(collectionName)}`;
  // The caller's signal, or a reset (RS-1), stops the import.
  const work = trackWork(signal);
  const checkCancelled = () => {
    if (work.signal.aborted) throw new ImportCancelledError();
  };
  let created = false;

  try {
    checkCancelled();
    setCollectionIndexStatus(collectionId, { state: "indexing", done: 0, total: 0 });
    onProgress?.({ stage: "reading" });
    const allDocs: ParsedDoc[] = [];
    let totalSizeBytes = 0;
    for (const file of files) {
      totalSizeBytes += file.size ?? 0;
      const fallbackTitle = file.name.replace(/\.[^.]+$/, "");
      allDocs.push(...(await parseFileContent(file, fallbackTitle)));
      checkCancelled();
    }

    onProgress?.({ stage: "chunking" });
    const chunks = toChunks(allDocs, collectionId);

    await createCustomCollection({
      id: collectionId,
      name: collectionName,
      sourceFilename: files.map((f) => f.name).join(", "),
      docCount: allDocs.length,
      chunkCount: chunks.length,
      sizeBytes: totalSizeBytes,
    });
    created = true;

    for (let i = 0; i < chunks.length; i++) {
      checkCancelled();
      onProgress?.({ stage: "embedding", chunkIndex: i, chunkCount: chunks.length });
      setCollectionIndexStatus(collectionId, { state: "indexing", done: i, total: chunks.length });
      const chunk = chunks[i];
      const embedding = await embeddingEngine.embed(`${chunk.title}\n${chunk.body}`);
      await insertChunk({ ...chunk, collectionId }, embedding);
    }
    checkCancelled();
    setCollectionIndexStatus(collectionId, { state: "indexed", done: chunks.length, total: chunks.length });

    const [collection] = (await listCustomCollections()).filter((c) => c.id === collectionId);
    return collection;
  } catch (e: any) {
    // Stopped by a reset (RS-1): the knowledge base is being deleted, so there is nothing to undo and nothing to
    // report; the caller sees a cancellation.
    if ((work.signal.aborted && !signal?.aborted) || isStopped(e)) {
      clearCollectionIndexStatus(collectionId);
      throw new ImportCancelledError();
    }
    if (created) await deleteCustomCollection(collectionId).catch((err) => console.warn("[import] cleanup failed:", err));
    if (e instanceof ImportCancelledError) {
      clearCollectionIndexStatus(collectionId);
    } else {
      setCollectionIndexStatus(collectionId, { state: "error", done: 0, total: 0, error: String(e?.message ?? e) });
    }
    throw e;
  } finally {
    work.done();
    // The picker's cache copy of a private document must not outlive the import, whatever its outcome.
    await discardPickerCopies(files);
  }
}

/** One file of a watched folder inside its collection: a short hash of its name (slugs of two names can collide). */
function fileKey(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  return `f${h.toString(36)}`;
}

export interface WatchedFolderBatch {
  collectionId: string;
  name: string;
  /** Nothing of this folder was imported before: start the collection over. */
  full: boolean;
  /** Copies (in the cache) of the new or changed files; deleted once imported, whatever the outcome. */
  upserts: DocumentPicker.DocumentPickerAsset[];
  /** File names gone from the folder. */
  removes: string[];
  /** Every file now in the folder and their total size, for the collection's summary. */
  files: string[];
  sizeBytes: number;
}

/**
 * Desktop "watched folder" (src/services/folderWatch.ts): brings the folder's collection in line with a batch of
 * changes. Each file's chunks carry a per-file id prefix, so a changed file replaces its old version and a deleted
 * one goes away. A file that can't be read (password-protected PDF, too big) is skipped and listed in `failed`;
 * other errors (no embedding model yet) throw, and the caller retries the whole batch later: the steps are
 * idempotent. Returns null when the collection is gone and the batch isn't a full one (the caller asks for a resync).
 */
export async function syncWatchedFolder(
  b: WatchedFolderBatch
): Promise<{ imported: number; failed: string[] } | null> {
  const work = trackWork();
  try {
    const exists = (await listCustomCollections()).some((c) => c.id === b.collectionId);
    if (!exists && !b.full) return null;
    if (exists && b.full) await deleteCollectionChunks(b.collectionId, b.collectionId);
    if (!exists) {
      await createCustomCollection({ id: b.collectionId, name: b.name, sourceFilename: "", docCount: 0, chunkCount: 0, sizeBytes: 0 });
    }
    for (const name of [...b.removes, ...b.upserts.map((f) => f.name)]) {
      await deleteCollectionChunks(b.collectionId, `${b.collectionId}-${fileKey(name)}-doc`); // "-doc": not another file's key
    }
    const failed: string[] = [];
    let imported = 0;
    for (const file of b.upserts) {
      let docs: ParsedDoc[];
      try {
        docs = await parseFileContent(file, file.name.replace(/\.[^.]+$/, ""));
      } catch (e: any) {
        console.warn(`[folder-watch] skipped ${file.name}:`, e?.message ?? e);
        failed.push(file.name);
        continue;
      }
      const chunks = toChunks(docs, `${b.collectionId}-${fileKey(file.name)}`);
      for (let i = 0; i < chunks.length; i++) {
        if (work.signal.aborted) throw new ImportCancelledError();
        setCollectionIndexStatus(b.collectionId, { state: "indexing", done: i, total: chunks.length });
        const embedding = await embeddingEngine.embed(`${chunks[i].title}\n${chunks[i].body}`);
        await insertChunk({ ...chunks[i], collectionId: b.collectionId }, embedding);
      }
      imported++;
    }
    await refreshCollectionSummary(b.collectionId, b.files.join(", "), b.sizeBytes);
    setCollectionIndexStatus(b.collectionId, { state: "indexed", done: 0, total: 0 });
    return { imported, failed };
  } finally {
    work.done();
    await discardPickerCopies(b.upserts);
  }
}

export { listCustomCollections, setCustomCollectionActive, deleteCustomCollection };

/**
 * Exports a collection back out as JSON in the same {title, source, body}[]
 * shape as the app's own downloadable corpus packs — portable, small, and
 * re-embeddable by any instance of the app regardless of embedding model
 * version. Not a raw .sqlite/.db export: that would bake in this device's
 * specific embedding vectors, which are meaningless (or wrong-dimension) on
 * a phone running a different embedding model. Hands off to the OS share
 * sheet so the user picks the transport (Bluetooth, Nearby Share, a file
 * manager, etc.) themselves.
 */
export async function exportCollection(collection: CustomCollection): Promise<void> {
  const docs = await getCollectionDocs(collection.id);
  const json = JSON.stringify(docs, null, 2);
  const path = `${FileSystem.cacheDirectory}${slug(collection.name)}.json`;
  await FileSystem.writeAsStringAsync(path, json);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, {
      mimeType: "application/json",
      dialogTitle: `Share "${collection.name}" knowledge base`,
    });
  } else {
    throw new Error("Sharing isn't available on this device");
  }
}
