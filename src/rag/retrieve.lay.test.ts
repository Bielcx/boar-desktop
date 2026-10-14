import { describe, it, expect, vi } from "vitest";

vi.mock("./db", () => ({ getDb: async () => ({ getAllAsync: async () => [] }) }));
vi.mock("./embed", () => ({ embeddingEngine: { embed: async () => new Float32Array([1, 0, 0, 0]) } }));
vi.mock("./ptLexiconAsset", () => ({ ptLexicon: () => ({}) }));

vi.mock("expo-file-system/legacy", () => ({ documentDirectory: "file:///docs/" }));
vi.mock("expo-sqlite", () => ({}));
const { hit, state } = vi.hoisted(() => ({
  hit: (chunkId: number, title: string, source: string, score: number, action = false) => ({
    articleId: chunkId, chunkId, title, section: "", text: `${title} text.`, start: 0, end: 10, score, via: "bm25" as const, source, views: 0, lead: false, action,
  }),
  state: { junk: false },
}));
// searchPacks chunks carry the question's cosine similarity, which retrieve()'s relevance gate reads
// (src/rag/pure.ts gateByRelevance); 0.8 is an on-topic match that passes it.
vi.mock("./packs", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    packHitToChunk: actual.packHitToChunk,
    // Keyword noise from other sources (bundled corpus, format-1 packs) with high scores.
    searchPacks: async () => ({
      lexical: state.junk
        ? [1, 2, 3, 4, 5, 6].map((i) => ({ chunkId: `junk${i}`, docId: `junk${i}`, title: `Junk ${i}`, body: "x", source: "Wikipedia", score: 100, similarity: 0.8, matchType: "lexical" as const }))
        : [],
      semantic: [],
    }),
    // Six clinical keyword hits, then the two lay sources the pack search adds past its limit.
    searchWikiPacks: async (query: string) => [
      {
        packId: "prep",
        stems: [],
        hits: [
          ...[1, 2, 3, 4, 5, 6].map((i) => hit(i, `Clinical ${i}`, "enwiki", 10 - i)),
          ...(/earthquake/i.test(query)
            ? [hit(9, "Earthquake safety", "enwikivoyage", 0.2, true), hit(10, "Earthquakes (Ready.gov)", "usgov", 0.1, true)]
            : []),
          hit(7, "US Army Survival Manual", "usgov", 1),
          hit(8, "Outdoor Survival/First Aid", "enwikibooks", 0.5),
        ],
      },
    ],
  };
});

import { retrieve } from "./retrieve";

describe("retrieve and lay sources", () => {
  it("keeps the lay sources a what-to-do search added past the limit", async () => {
    const titles = (await retrieve("snakebite snake bite what to do", 6)).map((c) => c.title);
    // Non-Wikipedia sources carry their label ("US government: …").
    expect(titles.some((t) => /US Army Survival Manual/.test(t))).toBe(true);
    expect(titles.some((t) => /Outdoor Survival\/First Aid/.test(t))).toBe(true);
  });

  it("cuts at the limit as before for other questions", async () => {
    expect(await retrieve("history of snakes in art", 6)).toHaveLength(6);
  });

  it("safety-008: puts pack sections that say what to do ahead of keyword noise, in English and Portuguese", async () => {
    state.junk = true;
    const en = (await retrieve("What should I do during an earthquake?", 6)).map((c) => c.title);
    const pt = (await retrieve("O que eu faço durante um terremoto?", 6, { lexicon: { terremoto: "Earthquake" } })).map((c) => c.title);
    state.junk = false;
    for (const titles of [en, pt]) {
      expect(titles.slice(0, 2).join(" | ")).toMatch(/Earthquake safety.*Earthquakes \(Ready\.gov\)/);
      expect(titles.slice(0, 6).some((t) => /Junk/.test(t))).toBe(true);
    }
  });
});
