import { describe, it, expect } from "vitest";
import { containedShare, dedupeArticleCopies } from "./dedupe";

const c = (chunkId: string, title: string, body: string) => ({ chunkId, title, body });

// The bundled lead and a pack's lead of the same article: same paragraph, slightly different text.
const BUNDLED = c(
  "c-vaccine",
  "Vaccine",
  "A vaccine is a biological preparation that provides active acquired immunity to a particular infectious disease. A vaccine typically contains an agent that resembles a disease-causing microorganism."
);
const PACK_LEAD = c(
  "pack:wiki-vital5:812",
  "Vaccine",
  "A vaccine is a biological preparation that provides active acquired immunity to a particular infectious or malignant disease. A vaccine typically contains an agent that resembles a disease-causing microorganism and is often made from weakened or killed forms of the microbe."
);
// Another section of the same article: the same vocabulary, different sentences.
const PACK_HISTORY = c(
  "pack:wiki-vital5:815",
  "Vaccine",
  "Edward Jenner tested the smallpox vaccine in 1796, using cowpox material. Vaccination campaigns later eradicated smallpox worldwide, and the vaccine for polio followed in the 1950s."
);

describe("dedupeArticleCopies", () => {
  it("keeps one copy of the same lead from two libraries, the first", () => {
    expect(dedupeArticleCopies([PACK_LEAD, BUNDLED]).map((x) => x.chunkId)).toEqual(["pack:wiki-vital5:812"]);
    expect(dedupeArticleCopies([BUNDLED, PACK_LEAD]).map((x) => x.chunkId)).toEqual(["c-vaccine"]);
  });

  it("keeps two different sections of one article", () => {
    expect(dedupeArticleCopies([PACK_LEAD, PACK_HISTORY, BUNDLED]).map((x) => x.chunkId)).toEqual([
      "pack:wiki-vital5:812",
      "pack:wiki-vital5:815",
    ]);
  });

  it("never merges different articles, even with the same text", () => {
    const other = { ...BUNDLED, chunkId: "c-other", title: "Vaccination" };
    expect(dedupeArticleCopies([BUNDLED, other])).toHaveLength(2);
  });

  it("matches titles ignoring case and spaces, and keeps the order", () => {
    const black = c("c-bh", "Black hole", "A black hole is a region of spacetime where gravity is so strong that nothing can escape.");
    const blackPack = c("pack:p:1", "black hole ", "A black hole is a region of spacetime where gravity is so strong that nothing, not even light, can escape.");
    const canberra = c("c-cb", "Canberra", "Canberra is the capital city of Australia.");
    expect(dedupeArticleCopies([black, canberra, blackPack]).map((x) => x.chunkId)).toEqual(["c-bh", "c-cb"]);
  });

  it("measures copies by word pairs, not shared vocabulary", () => {
    expect(containedShare(PACK_LEAD.body, BUNDLED.body)).toBeGreaterThan(0.9);
    expect(containedShare(PACK_LEAD.body, PACK_HISTORY.body)).toBeLessThan(0.2);
  });
});
