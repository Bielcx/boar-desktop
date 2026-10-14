/// <reference types="node" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSqliteDatabase } from "./testing/nodeSqlite";

// retrievePassages end to end over a real format-2 pack built from the test
// fixture, installed where packs.ts looks for packs (mocked file system).
const dir = mkdtempSync(join(tmpdir(), "boar-passages-"));
const packFile = join(dir, "mini-wiki.sqlite");

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  readDirectoryAsync: async () => ["mini-wiki.sqlite"],
  getInfoAsync: async () => ({ exists: true, size: 1 }),
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: async () => nodeSqliteDatabase(packFile) }));
vi.mock("./embed", () => ({ embeddingEngine: { embed: async () => { throw new Error("no embedding model in tests"); } } }));
vi.mock("./retrieve", () => ({
  retrieve: async () => [
    { chunkId: "wiki-min-black-hole", docId: "x", title: "Black hole", body: "A black hole bends light. Unrelated words here.", source: "Wikipedia — https://en.wikipedia.org/wiki/Black_hole", score: 1, matchType: "lexical" },
  ],
}));

beforeAll(() => {
  execFileSync(process.execPath, ["scripts/build-wiki-pack.mjs", "--out", packFile, "--shards", "src/rag/testing/fixtures/mini-wiki.jsonl", "--no-embed", "--chunk-chars", "300"], { stdio: "pipe" });
}, 60000);

describe("retrievePassages", () => {
  it("returns sentence-level passages with sources, the lead on the top one, and popularity", async () => {
    const { retrievePassages } = await import("./passages");
    const r = await retrievePassages("How does a black hole form?");
    const top = r.passages[0];
    // The Formation section answers "how does it form" best; the article's lead rides along for the instant tier.
    expect(top.source).toEqual({ title: "Black hole", section: "Formation", url: "https://en.wikipedia.org/wiki/Black_hole", kind: "enwiki" });
    expect(top.id).toMatch(/^pack:local-mini-wiki:\d+$/);
    expect(top.lead).toBe("A black hole is a region of spacetime where gravity is so strong that nothing, not even light, can escape. The boundary is called the event horizon.");
    expect(top.text).toMatch(/collapses/);
    expect(r.passages.some((p) => p.source.section === "" && p.source.title === "Black hole")).toBe(true);
    for (const p of r.passages) for (const s of p.sentences) expect(s.score).toBeGreaterThanOrEqual(0), expect(s.score).toBeLessThanOrEqual(1);
    expect(r.longTail).toBe(false);
    // The built-in chunk is kept after the pack's passages, not dropped.
    expect(r.passages.some((p) => p.id === "wiki-min-black-hole" && p.source.kind === "builtin")).toBe(true);
  });

  it("flags long-tail topics and respects the character budget", async () => {
    const { retrievePassages } = await import("./passages");
    const r = await retrievePassages("Why was Kuala Kubu Bharu rebuilt?", { charBudget: 200 });
    expect(r.longTail).toBe(true);
    expect(r.passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(200);
  });
});
