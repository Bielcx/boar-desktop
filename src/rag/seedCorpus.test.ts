/// <reference types="node" />
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeSqliteDatabase } from "./testing/nodeSqlite";

let current: ReturnType<typeof nodeSqliteDatabase>;
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async () => current,
  deleteDatabaseAsync: async () => {},
}));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///nowhere/",
  getInfoAsync: async () => ({ exists: false }),
  readAsStringAsync: async () => "[]",
}));
vi.mock("./embed", () => ({
  embeddingEngine: { embed: async () => new Float32Array([1, 0, 0, 0]) },
}));

const corpusDir = join(__dirname, "../../assets/corpus");
const bundled = ["corpus.json", "corpus-standard.json", "corpus-full.json"].flatMap(
  (f) => JSON.parse(readFileSync(join(corpusDir, f), "utf8")) as Array<{ title: string; source: string; body: string }>
);

describe("bundled corpus provenance", () => {
  it("every document cites a Wikipedia article as its source", () => {
    const uncited = bundled.filter((d) => !/^Wikipedia — https:\/\/en\.wikipedia\.org\/wiki\/\S+$/.test(d.source));
    expect(uncited.map((d) => d.title)).toEqual([]);
  });
});

describe("seedKnowledgeBaseIfEmpty", () => {
  beforeEach(async () => {
    vi.resetModules();
    current = nodeSqliteDatabase();
  });

  it("seeds only the Wikipedia corpus and removes the retired hand-written notes", async () => {
    const db = await import("./db");
    const { seedKnowledgeBaseIfEmpty, RETIRED_SEED_IDS } = await import("./seedCorpus");
    // An install from an older version still has the hand-written notes, plus an imported doc.
    await db.createCustomCollection({ id: "mine", name: "Mine", sourceFilename: null, docCount: 1, chunkCount: 1, sizeBytes: 1 });
    await db.insertChunk({ chunkId: "app-moe-ram", docId: "app-moe-ram", title: "MoE", body: "hand-written", source: "aoair seed corpus" }, new Float32Array(4));
    await db.insertChunk({ chunkId: "user-1", docId: "user-1", title: "Notes", body: "my own", collectionId: "mine" }, new Float32Array(4));

    await seedKnowledgeBaseIfEmpty();

    const sources = current.raw.prepare("SELECT DISTINCT source FROM chunks WHERE collection_id IS NULL").all() as Array<{ source: string }>;
    expect(sources.every((s) => s.source.startsWith("Wikipedia — "))).toBe(true);
    for (const table of ["chunks", "chunks_fts", "chunk_embeddings"]) {
      const marks = RETIRED_SEED_IDS.map(() => "?").join(",");
      const left = current.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE chunk_id IN (${marks})`).get(...RETIRED_SEED_IDS) as { n: number };
      expect(left.n, table).toBe(0);
    }
    const seeded = current.raw.prepare("SELECT COUNT(*) AS n FROM chunks WHERE collection_id IS NULL").get() as { n: number };
    expect(seeded.n).toBe(300);
    const mine = current.raw.prepare("SELECT COUNT(*) AS n FROM chunks WHERE collection_id = 'mine'").get() as { n: number };
    expect(mine.n).toBe(1);
  });
});

describe("per-collection indexing", () => {
  beforeEach(() => {
    vi.resetModules();
    current = nodeSqliteDatabase();
  });

  it("reports progress and status per collection", async () => {
    const { seedKnowledgeBaseIfEmpty, onSeedProgress, getCollectionIndexStatus, BUILTIN_COLLECTION_ID } = await import("./seedCorpus");
    const seen: string[] = [];
    const stop = onSeedProgress((p) => seen.push(p.collectionId));
    await seedKnowledgeBaseIfEmpty();
    stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([BUILTIN_COLLECTION_ID]));
    expect(getCollectionIndexStatus()[BUILTIN_COLLECTION_ID]).toEqual({ state: "indexed", done: 300, total: 300 });
  });

  it("removeCorpusPackIndex deletes only that pack's chunks", async () => {
    const db = await import("./db");
    const { seedKnowledgeBaseIfEmpty, removeCorpusPackIndex } = await import("./seedCorpus");
    await seedKnowledgeBaseIfEmpty();
    const vec = new Float32Array(4);
    await db.insertChunk({ chunkId: "wiki-corpus-standard-foo", docId: "x", title: "Foo", body: "foo" }, vec);
    await db.insertChunk({ chunkId: "wiki-corpus-standard-bar", docId: "y", title: "Bar", body: "bar" }, vec);
    await db.insertChunk({ chunkId: "wiki-corpus-full-foo", docId: "z", title: "Foo", body: "foo" }, vec);

    expect(await removeCorpusPackIndex({ id: "corpus-standard", format: "json" })).toBe(2);

    const ids = (current.raw.prepare("SELECT chunk_id FROM chunks_fts WHERE chunk_id GLOB 'wiki-corpus-*'").all() as Array<{ chunk_id: string }>).map((r) => r.chunk_id);
    expect(ids).toEqual(["wiki-corpus-full-foo"]);
    const builtin = current.raw.prepare("SELECT COUNT(*) AS n FROM chunks WHERE chunk_id GLOB 'wiki-min-*'").get() as { n: number };
    expect(builtin.n).toBe(300);
  });
});
