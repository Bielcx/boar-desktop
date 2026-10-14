import { describe, it, expect } from "vitest";
import { buildLexicalQuery } from "./pure";
import { EXPLAIN_INTENT, explainingFirst } from "./explain";

describe("explain intent (RF-1)", () => {
  it("reads why/what-causes questions in English and Portuguese", () => {
    for (const q of ["Why do earthquakes happen near plate boundaries?", "What causes the monsoon?", "How does a monsoon form?", "Por que os terremotos acontecem perto das bordas das placas?", "O que causa as monções?"]) {
      expect(EXPLAIN_INTENT.test(q), q).toBe(true);
    }
    for (const q of ["What is the capital of France?", "Tell me the best vegan restaurants in Berlin"]) expect(EXPLAIN_INTENT.test(q), q).toBe(false);
  });

  it("puts the chunk with the question's other words first within its article, keeping the scores in place", () => {
    const terms = buildLexicalQuery("Why do earthquakes happen near plate boundaries?")!.terms;
    const items = [
      { title: "Plate tectonics", body: "Plate tectonics is the theory that the lithosphere is made of plates.", score: 9 },
      { title: "Seafloor", body: "Seafloor spreading at ridges.", score: 8 },
      { title: "Plate tectonics", body: "Most earthquakes happen at plate boundaries, where plates collide or slide.", score: 7 },
    ];
    const out = explainingFirst(items, terms);
    expect(out.map((c) => c.body.slice(0, 12))).toEqual(["Most earthqu", "Seafloor spr", "Plate tecton"]);
    expect(out.map((c) => c.score)).toEqual([9, 8, 7]);
  });
});
