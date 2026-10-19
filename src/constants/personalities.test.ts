import { describe, it, expect } from "vitest";
import { answerStyleFor } from "./personalities";

describe("answerStyleFor", () => {
  it("answers health and first-aid questions in Succinct when Detailed is picked", () => {
    for (const q of [
      "When should a burn see a doctor?",
      "How do I treat a minor kitchen burn?",
      "My hiking partner is shivering, confused and slurring words",
      "I was stung by a box jellyfish while swimming. Should I rinse it?",
      "My child spilled boiling water on their arm. What do I do?",
      "Meu amigo está tremendo, confuso e com a fala enrolada",
      "Como estancar um sangramento no nariz?",
    ])
      expect(answerStyleFor("detailed", q), q).toBe("succinct");
  });

  it("keeps Detailed for research questions, and any other style as chosen", () => {
    for (const q of [
      "What are the main sights to see in Lisbon?",
      "What is the difference between optimistic and zk-rollups?",
      "What is a seed phrase in a crypto wallet?",
      "Which countries are bigger than India by area?",
    ])
      expect(answerStyleFor("detailed", q), q).toBe("detailed");
    expect(answerStyleFor("summary", "How do I treat a minor kitchen burn?")).toBe("summary");
  });
});
