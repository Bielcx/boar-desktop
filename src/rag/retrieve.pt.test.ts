import { describe, it, expect, vi } from "vitest";

const calls: string[] = [];
vi.mock("./db", () => ({ getDb: async () => ({ getAllAsync: async () => [] }) }));
vi.mock("./embed", () => ({ embeddingEngine: { embed: async () => new Float32Array([1, 0, 0, 0]) } }));
vi.mock("./ptLexiconAsset", () => ({ ptLexicon: () => ({}) }));
// searchPacks chunks carry the question's cosine similarity, which retrieve()'s relevance gate reads
// (src/rag/pure.ts gateByRelevance); 0.8 is an on-topic match that passes it.
vi.mock("./packs", () => ({
  packHitToChunk: () => {
    throw new Error("unused");
  },
  searchWikiPacks: async () => [],
  // Stands in for an English source: only English words match.
  searchPacks: async (query: string) => {
    calls.push(query);
    const chunk = (id: string, title: string, body: string, action?: boolean) =>
      ({ chunkId: id, docId: id, title, body, source: "Wikipedia", score: 5, similarity: 0.8, matchType: "lexical" as const, ...(action === undefined ? {} : { action }) });
    if (/snakebite/i.test(query)) {
      return {
        lexical: [
          chunk("pack:v5:tree", "Tree snake", "Tree snake may refer to: any arboreal snake…"),
          chunk("pack:prep:lead", "Snakebite", "A snakebite is an injury caused by the bite of a snake.", false),
          chunk("pack:prep:treat", "Snakebite", "Keep the person still and calm; immobilize the bitten limb.", true),
        ],
        semantic: [],
      };
    }
    if (/ethereum/i.test(query)) {
      return {
        lexical: [
          chunk("pack:c:eth", "Ethereum", "Ethereum is a decentralized blockchain."),
          chunk("pack:c:1559", "EIP-1559: Fee market change for ETH 1.0 chain", "A base fee per gas that is burned."),
        ],
        semantic: [],
      };
    }
    if (/^road$/i.test(query)) return { lexical: [chunk("pack:v5:road", "Road", "A road is a thoroughfare.", false)], semantic: [] };
    const lexical = /season/i.test(query)
      ? [{ chunkId: "pack:vital5:1", docId: "pack:vital5:Season", title: "Season", body: "A season is a division of the year.", source: "Wikipedia", score: 9, similarity: 0.8, matchType: "lexical" as const }]
      : /cultivo|jardim/i.test(query)
        ? [{ chunkId: "pack:prep:9", docId: "pack:prep:Jardim", title: "Jardim Vertical", body: "Jardim vertical para cultivo o ano todo.", source: "Appropedia", score: 3, similarity: 0.8, matchType: "lexical" as const }]
        : [];
    return { lexical, semantic: [] };
  },
}));

import { retrieve } from "./retrieve";
import { identifiersIn, titleHasIdentifier } from "./identifiers";

const lexicon = { "estacao do ano": "Season", terra: "Earth" };

describe("retrieve with Portuguese questions", () => {
  it("searches again with the English names a Portuguese question mentions, and puts those results first", async () => {
    calls.length = 0;
    const hits = await retrieve("Por que existem estações do ano na Terra? (cultivo)", 6, { lexicon });
    expect(calls).toContain("Season Earth");
    expect(hits[0]?.title).toBe("Season");
    expect(hits.map((h) => h.title)).toContain("Jardim Vertical");
  });

  it("leaves English questions alone", async () => {
    calls.length = 0;
    await retrieve("Why do we have seasons on Earth?", 6, { lexicon });
    expect(calls).toEqual(["Why do we have seasons on Earth?"]);
  });

  it("in a what-to-do question puts action sections first and never cites a disambiguation list", async () => {
    const hits = await retrieve("Fui mordido por uma picada de cobra na trilha. O que eu faço?", 6, { lexicon: { "picada de cobra": "Snakebite" } });
    expect(hits[0]?.body).toMatch(/immobilize/);
    expect(hits.map((h) => h.title)).not.toContain("Tree snake");
  });

  it("in a what-to-do question never puts a generic name's article first", async () => {
    const hits = await retrieve("Meu parceiro está na estrada com frio. O que eu faço? (cultivo)", 6, { lexicon: { estrada: "Road" } });
    expect(hits[0]?.title).toBe("Jardim Vertical");
  });

  it("puts the page of a standard named by number ahead of the lexicon's names", async () => {
    calls.length = 0;
    const hits = await retrieve("O que a EIP 1559 muda nas taxas do Ethereum?", 6, { lexicon: { ethereum: "Ethereum" } });
    expect(calls).toContain("EIP-1559 Ethereum");
    expect(hits[0]?.title).toMatch(/^EIP-1559:/);
  });

  it("reads standards' numbers in any spelling, and matches only the same number", () => {
    expect(identifiersIn("a eip1559, a ERC-20 e o bip 32 e a EIP-1559")).toEqual(["EIP-1559", "ERC-20", "BIP-32"]);
    expect(identifiersIn("Ethereum 2.0 e o ano 1559")).toEqual([]);
    expect(titleHasIdentifier("EIP-1559: Fee market change", "EIP-1559")).toBe(true);
    expect(titleHasIdentifier("EIP-155: Simple replay attack protection", "EIP-1559")).toBe(false);
    expect(titleHasIdentifier("EIP-15590: other", "EIP-1559")).toBe(false);
  });
});
