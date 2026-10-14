import { describe, expect, it } from "vitest";
import { questionTitle, sessionTitleFor } from "./sessionTitle.pure";

const Q = "How long should I boil river water at Camp Tamandua?";

describe("sessionTitleFor", () => {
  it("keeps a title made of the question", () => {
    expect(sessionTitleFor("Boiling River Water Camp Tamandua", Q)).toBe("Boiling River Water Camp Tamandua");
    expect(sessionTitleFor("Black Holes Explained", "What is a black hole?")).toBe("Black Holes Explained");
    expect(sessionTitleFor("Pandemia e epidemia", "Qual a diferença entre pandemia e epidemia?")).toBe("Pandemia e epidemia");
  });

  it("drops a title that answers the question with a number the question doesn't have", () => {
    expect(sessionTitleFor("Boil for 10 minutes.", Q)).toBe("How long should I boil river water at Camp Tamandua");
    expect(sessionTitleFor("Boil for at least 10 minutes.", Q)).toBe("How long should I boil river water at Camp Tamandua");
    expect(sessionTitleFor("Mount Everest 8849 m", "How tall is Mount Everest?")).toBe("How tall is Mount Everest");
  });

  it("keeps numbers the question has", () => {
    expect(sessionTitleFor("Events of 1969", "What happened in 1969?")).toBe("Events of 1969");
  });

  it("drops a title with none of the question's words, or none at all", () => {
    expect(sessionTitleFor("Hydration Tips", Q)).toBe("How long should I boil river water at Camp Tamandua");
    expect(sessionTitleFor("  ", "What is a monsoon?")).toBe("What is a monsoon");
  });
});

describe("questionTitle", () => {
  it("trims long questions at a word, and never returns an empty title", () => {
    const long = "Can you explain in detail how the immune system distinguishes between harmful pathogens and the body's own cells?";
    const t = questionTitle(long);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith("…")).toBe(true);
    expect(questionTitle("   ")).toBe("New chat");
  });
});
