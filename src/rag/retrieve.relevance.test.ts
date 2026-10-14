import { describe, it, expect } from "vitest";
import { filterByMinScore, fuseRetrievalResults, gateByRelevance, MIN_SEMANTIC_SIMILARITY } from "./pure";
import type { RetrievedChunk } from "./retrieve.types";

/**
 * Retrieval relevance tests. These exercise the FUSION/THRESHOLD MECHANICS
 * extracted into pure.ts — deterministic, native-module-free logic — using
 * synthetic scores, not real bge-small-en-v1.5 embeddings or FTS5 bm25
 * output. There's no on-device runtime available in this sandbox to
 * measure this corpus's actual score distribution for real queries like
 * "what is a black hole?" or "asdfghjkl qwerty", so these tests validate
 * that the CODE correctly implements the relevance policy it claims to
 * (raw-score floor before normalization; empty in -> empty out; a single
 * strong source isn't discarded) rather than asserting anything about real
 * embedding behavior. Hands-on verification of the specific example
 * queries in the request against the real model/corpus is a follow-up,
 * not something this sandbox can do.
 */

function chunk(id: string, score: number, matchType: RetrievedChunk["matchType"] = "lexical"): RetrievedChunk {
  return { chunkId: id, docId: id, title: `Doc ${id}`, body: `Body ${id}`, score, matchType };
}

describe("filterByMinScore", () => {
  it("excludes scores below the floor and keeps scores at or above it", () => {
    const floor = MIN_SEMANTIC_SIMILARITY;
    const chunks = [chunk("a", 0.9), chunk("b", floor - 0.01), chunk("c", floor), chunk("d", 0.1)];
    const kept = filterByMinScore(chunks, MIN_SEMANTIC_SIMILARITY);
    expect(kept.map((c) => c.chunkId)).toEqual(["a", "c"]);
  });

  it("returns empty when every score is below the floor — the 'gibberish query' case", () => {
    // Simulates "asdfghjkl qwerty": semanticSearch's real cosine scores
    // against genuine gibberish should all land well below the floor (a
    // meaningful embedding needs some actual semantic content to match
    // against) — this test proves the floor mechanics themselves correctly
    // produce zero results when that's what upstream scoring reports,
    // regardless of what the real numbers turn out to be.
    const chunks = [chunk("a", 0.2), chunk("b", 0.1), chunk("c", 0.05)];
    expect(filterByMinScore(chunks, MIN_SEMANTIC_SIMILARITY)).toEqual([]);
  });

  it("does not discard a single weak-but-real match above the floor", () => {
    // "a legitimate query with weak/partial wording" — a chunk barely
    // above the floor must still survive, not be treated as noise just
    // because it's not a strong match.
    const chunks = [chunk("a", MIN_SEMANTIC_SIMILARITY + 0.01)];
    expect(filterByMinScore(chunks, MIN_SEMANTIC_SIMILARITY)).toEqual(chunks);
  });
});

describe("fuseRetrievalResults", () => {
  it("returns empty when both sources have nothing — never forces a top-K of near-random matches", () => {
    // Direct regression for the "no arbitrary corpus padding" requirement:
    // if lexicalSearch's exact-phrase gate and semanticSearch's
    // MIN_SEMANTIC_SIMILARITY floor both correctly report nothing, fusion
    // must not synthesize a result out of nothing to fill topK.
    expect(fuseRetrievalResults([], [], 6)).toEqual([]);
  });

  it("surfaces a single-source match rather than discarding it for lacking corroboration", () => {
    // "a legitimate query with weak/partial wording" — e.g. an exact
    // lexical phrase hit with no semantic corroboration (or vice versa)
    // must not be silently dropped just because only one source found it.
    const lexicalOnly = [chunk("a", 3.2, "lexical")];
    const result = fuseRetrievalResults(lexicalOnly, [], 6);
    expect(result).toHaveLength(1);
    expect(result[0].chunkId).toBe("a");
    expect(result[0].matchType).toBe("lexical");
  });

  it("promotes a chunk found by both sources to hybrid and ranks it above single-source matches", () => {
    const agreed = chunk("a", 3.0, "lexical");
    const agreedSemantic = { ...chunk("a", 0.8, "semantic") };
    const onlyLexical = chunk("b", 2.0, "lexical");
    const result = fuseRetrievalResults([agreed, onlyLexical], [agreedSemantic], 6);
    expect(result[0].chunkId).toBe("a");
    expect(result[0].matchType).toBe("hybrid");
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it("respects topK even when both sources contribute more results than that", () => {
    const lexical = Array.from({ length: 8 }, (_, i) => chunk(`l${i}`, 8 - i, "lexical"));
    const semantic = Array.from({ length: 8 }, (_, i) => chunk(`s${i}`, 0.9 - i * 0.01, "semantic"));
    expect(fuseRetrievalResults(lexical, semantic, 6)).toHaveLength(6);
  });

  it("weights lexical and semantic contributions as configured, not just 50/50 by default", () => {
    const lexicalOnly = [chunk("a", 3.2, "lexical")];
    const semanticOnly = [chunk("b", 0.9, "semantic")];
    const semanticFavored = fuseRetrievalResults(lexicalOnly, semanticOnly, 6, { lexical: 0.2, semantic: 0.8 });
    expect(semanticFavored.find((c) => c.chunkId === "b")!.score).toBeGreaterThan(
      semanticFavored.find((c) => c.chunkId === "a")!.score
    );
  });

  it("is deterministic: identical inputs always produce an identical ranking", () => {
    const lexical = [chunk("a", 2.5, "lexical"), chunk("b", 1.1, "lexical")];
    const semantic = [chunk("b", 0.7, "semantic"), chunk("c", 0.5, "semantic")];
    expect(fuseRetrievalResults(lexical, semantic, 6)).toEqual(fuseRetrievalResults(lexical, semantic, 6));
  });

  it("keeps at most two chunks per article, so a second topic isn't crowded out", () => {
    const c = (id: string, title: string, score: number) => ({ chunkId: id, docId: id, title, body: "", score, matchType: "lexical" as const });
    const lexical = [c("n1", "Napoleon", 9), c("n2", "Napoleon", 8), c("n3", "Napoleon", 7), c("f1", "French Revolution", 3)];
    expect(fuseRetrievalResults(lexical, [], 4).map((r) => r.chunkId)).toEqual(["n1", "n2", "f1"]);
  });
});

describe("gateByRelevance", () => {
  const c = (title: string, similarity?: number) => ({ title, similarity });

  it("keeps every chunk above the floor, including a comparison's weaker second topic", () => {
    const out = gateByRelevance([c("Industrial Revolution", 0.84), c("French Revolution", 0.74), c("Long Depression", 0.62)]);
    expect(out.map((x) => x.title)).toEqual(["Industrial Revolution", "French Revolution"]);
  });

  it("returns nothing when no chunk reaches the floor", () => {
    expect(gateByRelevance([c("Support group", 0.57), c("Suicide crisis", 0.55)])).toEqual([]);
  });

  it("drops chunks with no similarity (keyword-only hits)", () => {
    expect(gateByRelevance([c("Vaccine", 0.76), c("Tim Peto")]).map((x) => x.title)).toEqual(["Vaccine"]);
    expect(gateByRelevance([c("Tim Peto")])).toEqual([]);
  });

  it("keeps order and handles an empty list", () => {
    expect(gateByRelevance([])).toEqual([]);
    expect(gateByRelevance([c("B", 0.74), c("A", 0.76)]).map((x) => x.title)).toEqual(["B", "A"]);
  });
});

describe("fuseRetrievalResults keeps the real similarity", () => {
  it("carries a semantic chunk's similarity into the fused (hybrid) chunk", () => {
    const lexical: RetrievedChunk[] = [{ chunkId: "v", docId: "v", title: "Vaccine", body: "b", score: 12, matchType: "lexical" }];
    const semantic: RetrievedChunk[] = [{ chunkId: "v", docId: "v", title: "Vaccine", body: "b", score: 0.76, similarity: 0.76, matchType: "semantic" }];
    const [fused] = fuseRetrievalResults(lexical, semantic, 4);
    expect(fused.matchType).toBe("hybrid");
    expect(fused.similarity).toBe(0.76);
  });
});
