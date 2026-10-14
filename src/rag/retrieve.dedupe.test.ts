import { describe, it, expect, vi } from "vitest";

vi.mock("./db", () => ({ getDb: async () => ({ getAllAsync: async () => [] }) }));
vi.mock("./embed", () => ({ embeddingEngine: { embed: async () => new Float32Array([1, 0, 0, 0]) } }));
vi.mock("./ptLexiconAsset", () => ({ ptLexicon: () => ({}) }));
vi.mock("expo-file-system/legacy", () => ({ documentDirectory: "file:///docs/" }));
vi.mock("expo-sqlite", () => ({}));

const { LEAD } = vi.hoisted(() => ({
  LEAD: "A vaccine is a biological preparation that provides active acquired immunity to a particular infectious disease. A vaccine typically contains an agent that resembles a disease-causing microorganism.",
}));

// The X6 Pro case: the question names "Vaccine", so the large pack's lead comes first (via title), and the
// bundled corpus (here through searchPacks, same gate) brings its own copy of the same lead.
vi.mock("./packs", async (importOriginal) => {
  const actual: any = await importOriginal();
  const bundled = (id: string, title: string, body: string) => ({ chunkId: id, docId: id, title, body, source: "Wikipedia", score: 10, similarity: 0.8, matchType: "lexical" as const });
  return {
    packHitToChunk: actual.packHitToChunk,
    searchPacks: async () => ({
      lexical: [
        bundled("c-vaccine", "Vaccine", LEAD),
        bundled("c-immune", "Immune system", "The immune system is a network of biological systems that protects an organism from diseases."),
        bundled("c-vaccination", "Vaccination", "Vaccination is the administration of a vaccine to help the immune system develop immunity from a disease."),
      ],
      semantic: [],
    }),
    searchWikiPacks: async () => [
      {
        packId: "wiki-vital5",
        stems: [],
        hits: [
          { articleId: 1, chunkId: 1, title: "Vaccine", section: "", text: LEAD, start: 0, end: LEAD.length, score: 5, via: "title" as const, source: "enwiki", views: 0, lead: true, action: false },
        ],
      },
    ],
  };
});

import { retrieve } from "./retrieve";

describe("retrieve: one copy of an article across libraries", () => {
  it("keeps the pack's Vaccine lead and drops the bundled copy, filling the slot with the next source", async () => {
    const titles = (await retrieve("How does a vaccine train the immune system?", 3)).map((c) => c.title);
    expect(titles.filter((t) => t === "Vaccine")).toHaveLength(1);
    expect(titles).toEqual(["Vaccine", "Immune system", "Vaccination"]);
  });
});
