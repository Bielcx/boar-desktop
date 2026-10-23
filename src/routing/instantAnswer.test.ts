import { describe, expect, it } from "vitest";
import { instantAnswer } from "./instantAnswer";

describe("instantAnswer (shared by answer() and the chat)", () => {
  it("answers the CO hazard with the fixed card", () => {
    const a = instantAnswer("Can I run my generator in the garage with the door open?");
    expect(a?.reasonCodes).toEqual(["answer:safety-fact-co-hazard"]);
    expect(a?.text).toMatch(/^No\./);
  });

  it("answers a population comparison from Wikidata", () => {
    const a = instantAnswer("Is Japan's population larger than Nigeria's?");
    expect(a?.reasonCodes[0]).toMatch(/^answer:facts-/);
    expect(a?.text).toMatch(/Nigeria has more people/);
  });

  it("leaves facts off when asked, and open questions to the model", () => {
    expect(instantAnswer("Is Japan's population larger than Nigeria's?", { facts: false })).toBeNull();
    expect(instantAnswer("How do black holes form?")).toBeNull();
  });
});

describe("the attribution survives the chat's clean-up", () => {
  it("keeps the source line of a fixed answer", async () => {
    const { cleanCitations } = await import("../services/citations");
    for (const q of ["Can I run my generator in the garage with the door open?", "Is Japan's population larger than Nigeria's?"]) {
      const a = instantAnswer(q)!;
      expect(cleanCitations(a.text, 0)).toMatch(/(Based on: CDC|From Wikidata)/);
    }
  });
});
