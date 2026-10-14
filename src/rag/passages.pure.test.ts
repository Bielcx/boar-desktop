import { describe, it, expect } from "vitest";
import { applyCharBudget, leadParagraph, selectSentences, splitSentences, termCoverage } from "./passages.pure";
import type { Passage } from "./passages.types";

const sentencesOf = (t: string) => splitSentences(t).map(([s, e]) => t.slice(s, e));

describe("splitSentences", () => {
  it("splits at sentence ends and lines", () => {
    expect(sentencesOf("One here. Two there! Three? \n- a list item\n- another")).toEqual([
      "One here.", "Two there!", "Three?", "- a list item", "- another",
    ]);
  });
  it("doesn't split after abbreviations, initials or decimals", () => {
    expect(sentencesOf("Dr. Smith met J. R. R. Tolkien in the U.S. Army. It cost 3.5 dollars.")).toEqual([
      "Dr. Smith met J. R. R. Tolkien in the U.S. Army.", "It cost 3.5 dollars.",
    ]);
  });
});

describe("selectSentences", () => {
  const terms = [
    { prefixes: ["collaps"], weight: 3 },
    { prefixes: ["star"], weight: 1 },
  ];
  const text = "Black holes are dense. They form when a massive star collapses. Nobody lives there. Stars shine.";

  it("scores sentences by the share of the question's term weight, 0..1", () => {
    expect(termCoverage("a massive star collapses", terms)).toBe(1);
    expect(termCoverage("Stars shine", terms)).toBe(0.25);
    expect(termCoverage("nothing", terms)).toBe(0);
  });
  it("keeps the best sentences in document order and drops ones with no question term", () => {
    expect(selectSentences(text, terms, 3, false).map((s) => s.text)).toEqual([
      "They form when a massive star collapses.", "Stars shine.",
    ]);
  });
  it("keeps a lead's first sentence (the definition) even without question terms", () => {
    const picked = selectSentences(text, terms, 2, true).map((s) => s.text);
    expect(picked).toEqual(["Black holes are dense.", "They form when a massive star collapses."]);
  });
});

describe("leadParagraph", () => {
  it("skips the title heading and infobox facts", () => {
    expect(leadParagraph("# X\n\nKey facts: a: b\n\nX is a thing. It is big.\n\n## More\n\nmore")).toBe("X is a thing. It is big.");
  });
});

describe("applyCharBudget", () => {
  const p = (id: string, ...s: string[]): Passage => ({
    id, text: s.join(" "), sentences: s.map((text) => ({ text, score: 0.5 })), score: 0.5,
    source: { title: id, section: "", url: "", kind: "enwiki" }, views: 0, via: "bm25",
  });
  it("stops when the budget is spent and trims the passage that overflows", () => {
    const out = applyCharBudget([p("a", "12345", "67890"), p("b", "abcde", "fghij")], 18);
    expect(out.map((x) => x.text)).toEqual(["12345 67890", "abcde"]);
  });
});
