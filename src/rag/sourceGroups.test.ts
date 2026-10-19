import { describe, it, expect } from "vitest";
import { articleKey, groupSources, renumberCitations } from "./sourceGroups";

const p = (docId: string, score: number | undefined, body: string) => ({ docId, title: docId, body, score });
const group = (ps: ReturnType<typeof p>[]) => groupSources(ps, (x) => x.score);

describe("groupSources (native app's SourceGroups)", () => {
  it("merges passages of one article and sorts by best score", () => {
    // Seen on the X6: Methane 85%, Methane clathrate 76%, Methane 85%, Methane clathrate 74%; 86% under 78%.
    const g = group([p("clathrate", 0.76, "c1"), p("methane", 0.85, "m1"), p("clathrate", 0.74, "c2"), p("methane", 0.86, "m2")]);
    expect(g.items.map((x) => [x.docId, x.score, x.body])).toEqual([
      ["methane", 0.86, "m2\n\nm1"],
      ["clathrate", 0.76, "c1\n\nc2"],
    ]);
    expect(Object.fromEntries(g.renumber)).toEqual({ 1: 2, 2: 1, 3: 2, 4: 1 });
  });

  it("puts unknown scores last and keeps ties in order", () => {
    expect(group([p("a", undefined, "a"), p("b", 0.5, "b"), p("c", 0.5, "c")]).items.map((x) => x.docId)).toEqual(["b", "c", "a"]);
  });

  it("treats the same page from two packs as one article", () => {
    const vital = articleKey({ source: "Wikipedia — https://en.wikipedia.org/wiki/Methane", docId: "pack:wiki-vital5:Methane", title: "Methane" });
    const big = articleKey({ source: "Wikipedia — https://en.wikipedia.org/wiki/Methane (CC BY-SA 4.0)", docId: "pack:enwiki:a42", title: "Methane" });
    expect(vital).toBe(big);
    expect(articleKey({ docId: "doc-7", title: "Notes" })).toBe("doc-7");
    expect(articleKey({ source: "My notes", docId: "", title: "Notes" })).toBe("Notes");
  });

  it("renumbers citations", () => {
    const map = new Map([[1, 2], [2, 1], [3, 2], [4, 1]]);
    expect(renumberCitations("Methane [2][4] traps heat [1]; ice [3].", map)).toBe("Methane [1] traps heat [2]; ice [2].");
    expect(renumberCitations("Out of range [9] stays.", map)).toBe("Out of range [9] stays.");
    expect(renumberCitations("Same [1] [2]", new Map([[1, 1], [2, 2]]))).toBe("Same [1] [2]");
  });
});
