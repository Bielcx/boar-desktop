import { describe, it, expect, vi } from "vitest";

vi.mock("expo-file-system/legacy", () => ({ documentDirectory: "file:///docs/" }));
vi.mock("expo-sqlite", () => ({}));
vi.mock("./embed", () => ({ embeddingEngine: {} }));

import { articleUrl, normalizeUrl, packHitToChunk } from "./packs";

describe("pack source URLs", () => {
  it("encodes a recorded URL that carries a raw title, and leaves encoded ones alone", () => {
    expect(articleUrl("Quantum cryptography", "enwiki", "https://en.wikipedia.org/wiki/Quantum cryptography")).toBe(
      "https://en.wikipedia.org/wiki/Quantum_cryptography"
    );
    expect(normalizeUrl("https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange")).toBe("https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange");
    expect(normalizeUrl("https://www.ready.gov/some page")).toBe("https://www.ready.gov/some%20page");
  });

  it("builds an encoded URL from the title when none is recorded", () => {
    expect(articleUrl("Diffie–Hellman key exchange", "enwiki")).toBe("https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange");
  });
});

describe("pack hits as retrieved chunks", () => {
  it("carry whether their section says what to do, for the answer's source choice", () => {
    const hit = { articleId: 1, chunkId: 2, title: "Burn", section: "Management", text: "Cool the burn.", start: 0, end: 14, score: 1, via: "title" as const, source: "enwiki" as const, views: 0, lead: false, action: true };
    expect(packHitToChunk("prep", hit).action).toBe(true);
    expect(packHitToChunk("prep", { ...hit, section: "Prevention", action: false }).action).toBe(false);
  });
});
