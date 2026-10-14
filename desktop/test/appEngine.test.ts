/// <reference types="node" />
// The app's own engine code (src/rag/db.ts, seedCorpus.ts, retrieve.ts, src/models/ModelManager.ts, fileHash.ts), unmodified,
// running on the desktop shims: every expo-sqlite / expo-file-system / file-hash / ram-monitor import inside src/ resolves
// to desktop/src/shims (as Metro does with BOAR_TARGET=desktop) and reaches the real main-side handlers through the
// IPC loopback, against a temp data folder.
//
// Real: SQLite (node:sqlite, FTS5, bm25, blobs, transactions), files, downloads (local HTTP server, Range resume),
// SHA-256 streaming, the app's seeding, retrieval, fusion and integrity code.
// Stubbed: the embedding model (a fake embedder below; llama.rn has its own test, llama.rn.test.ts), and bundled-assets (unused here).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupDesktop } from "./setup";
import { serve } from "./testServer";

vi.mock("expo-sqlite", () => import("../src/shims/expo-sqlite"));
vi.mock("expo-file-system", () => import("../src/shims/expo-file-system"));
vi.mock("expo-file-system/legacy", () => import("../src/shims/expo-file-system-legacy"));
vi.mock("file-hash", () => import("../src/shims/file-hash"));
vi.mock("ram-monitor", () => import("../src/shims/ram-monitor"));
vi.mock("bundled-assets", () => ({ excludeFromBackup: async () => {} }));

// Fake embedder: one dimension per corpus title. A text gets weight on the title it starts with (a document is embedded
// as "title\nbody") or names (a question), so a question about an article is close to that article and far from the rest.
const corpus = JSON.parse(readFileSync(join(__dirname, "../../assets/corpus/corpus.json"), "utf8")) as Array<{ title: string }>;
const titles = corpus.map((d) => d.title.toLowerCase());
vi.mock("../../src/rag/embed", () => ({
  embeddingEngine: {
    embed: async (text: string) => {
      const v = new Float32Array(titles.length + 1);
      v[titles.length] = 0.05;
      const t = text.toLowerCase();
      const first = t.split("\n")[0];
      titles.forEach((title, i) => {
        if (first === title || (!t.includes("\n") && new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t))) v[i] = 1;
      });
      return v;
    },
  },
}));

const env = setupDesktop();

describe("RAG engine on the desktop shims", () => {
  it("seeds the bundled corpus and answers a retrieval query end to end", async () => {
    const { seedKnowledgeBaseIfEmpty } = await import("../../src/rag/seedCorpus");
    const { retrieve } = await import("../../src/rag/retrieve");
    const db = await import("../../src/rag/db");

    await seedKnowledgeBaseIfEmpty();
    const conn = await db.getDb();
    expect((await conn.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM chunks"))!.n).toBe(300);
    expect((await conn.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM chunks_fts"))!.n).toBe(300);
    // The database file is where expo would put it: documentDirectory/SQLite/.
    expect(readFileSync(join(env.dataDir, "documents", "SQLite", "aoair_knowledge.db")).length).toBeGreaterThan(0);

    const hits = await retrieve("How does CRISPR edit genes?", 4);
    expect(hits[0].title).toBe("CRISPR");
    expect(hits[0].similarity).toBeGreaterThan(0.9); // the stored blob came back as a usable Float32Array
    expect(hits.every((h) => h.chunkId.startsWith("wiki-min-"))).toBe(true);

    // Lexical (FTS5/bm25) path on its own: a word from the body, not a title.
    const rows = await conn.getAllAsync<{ title: string }>(
      "SELECT title FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 3",
      ['"spacetime"']
    );
    expect(rows.map((r) => r.title)).toContain("Black hole");

    // Nothing relevant: the relevance gate leaves no sources.
    expect(await retrieve("zzqx flibbertigibbet", 4)).toEqual([]);

    // Seeding again is a no-op (one COUNT), and a custom collection round-trips through writeTransaction.
    await seedKnowledgeBaseIfEmpty();
    await db.createCustomCollection({ id: "mine", name: "Mine", sourceFilename: null, docCount: 1, chunkCount: 1, sizeBytes: 1 });
    await db.insertChunk({ chunkId: "u1", docId: "u1", title: "Notes", body: "my notes", collectionId: "mine" }, new Float32Array(titles.length + 1));
    expect(await db.getCollectionDocs("mine")).toEqual([{ title: "Notes", body: "my notes", source: "" }]);
    await db.deleteCustomCollection("mine");
    expect(await db.listCustomCollections()).toEqual([]);

    // "Erase everything": one transaction over every table, then VACUUM and a WAL checkpoint.
    await db.wipeDatabase();
    expect((await (await db.getDb()).getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM chunks"))!.n).toBe(0);
  }, 60_000);
});

describe("ModelManager on the desktop shims", () => {
  const body = Buffer.alloc(700 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7 + 3) % 256;
  const asset = {
    id: "test-model",
    kind: "llm",
    label: "Test model",
    filename: "models/test.gguf",
    sizeBytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    sourceUrl: "",
    license: "MIT",
    description: "test",
    required: false,
  } as any;
  let server: Awaited<ReturnType<typeof serve>>;

  beforeAll(async () => {
    process.env.BOAR_ALLOW_HTTP_DOWNLOADS = "1";
    server = await serve(body, { dropAt: 256 * 1024, delayMs: 5 });
    asset.sourceUrl = server.url;
  });
  afterAll(async () => {
    delete process.env.BOAR_ALLOW_HTTP_DOWNLOADS;
    await server.close();
  });

  it("downloads, survives a dropped connection by resuming, and verifies the sha256", async () => {
    const { ModelManager } = await import("../../src/models/ModelManager");
    const mm = new ModelManager([asset]);
    const progress: string[] = [];

    // The server cuts the connection after 256 KiB: the app keeps the bytes and reports "interrupted".
    const first = await mm.downloadCatalogModel(asset).catch((e) => e);
    expect(first?.info?.code ?? first?.message).toMatch(/interrupted/);
    const partial = await mm.statusOf(asset);
    expect(partial.present).toBe(false);
    expect(partial.partialBytes).toBeGreaterThan(0);

    // Retry: the app resumes from the file's length with a Range request; verification hashes through file-hash.
    await mm.downloadCatalogModel(asset, (p) => progress.push(p.phase ?? "?"));
    expect(server.ranges[1]).toBe(`bytes=${partial.partialBytes}-`);
    expect(progress).toContain("downloading");
    expect(progress).toContain("verifying");
    const status = await mm.statusOf(asset);
    expect(status).toMatchObject({ present: true, sizeOnDiskBytes: body.length, checksumOk: true });
    expect(readFileSync(join(env.dataDir, "documents", "models", "test.gguf")).equals(body)).toBe(true);
  });

  it("imports a file by content: copy + sha256 in one pass (file-hash), then moved into place", async () => {
    const { ModelManager } = await import("../../src/models/ModelManager");
    const { sha256OfFile, sizeOfFile } = await import("../../src/models/fileHash");
    const mm = new ModelManager([asset]);
    await mm.deleteModel(asset);
    writeFileSync(join(env.dataDir, "app-cache", "picked.gguf"), body);
    const picked = `${env.native.dirs.cache}picked.gguf`;
    expect(await sizeOfFile(picked)).toBe(body.length);
    expect(await sha256OfFile(picked)).toBe(asset.sha256);
    expect((await mm.importFromFile(picked, undefined, undefined, [asset])).id).toBe("test-model");
    expect(await mm.statusOf(asset)).toMatchObject({ present: true, sizeOnDiskBytes: body.length });
  });
});
