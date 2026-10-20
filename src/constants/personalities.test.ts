import { describe, it, expect } from "vitest";
import { answerStyleFor, getPersonality, offeredStyles, promptFor, shortAnswerReason } from "./personalities";
import { isSeedPhraseQuestion } from "../routing/context";
import { classifyTask } from "../routing/classify";

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
      "Which countries are bigger than India by area?",
    ])
      expect(answerStyleFor("detailed", q), q).toBe("detailed");
    expect(answerStyleFor("summary", "How do I treat a minor kitchen burn?")).toBe("summary");
  });
});

describe("offeredStyles", () => {
  it("hides Custom unless it's the style in use", () => {
    expect(offeredStyles("succinct").map((p) => p.id)).toEqual(["succinct", "detailed", "summary"]);
    expect(offeredStyles("custom").map((p) => p.id)).toContain("custom");
  });
});

describe("shortAnswerReason (the native app's ShortAnswer)", () => {
  it("keeps seed-phrase questions short, and only wallet keys count", () => {
    for (const q of ["How should I store my seed phrase?", "Where do I keep my 24-word recovery phrase?", "¿Dónde guardo mi frase semilla?", "Como guardar minha chave privada da carteira bitcoin?"]) {
      expect(isSeedPhraseQuestion(q), q).toBe(true);
      expect(shortAnswerReason("detailed", q), q).toBe("seed");
    }
    for (const q of ["How do I make an SSH private key?", "A mnemonic for the planets"]) expect(isSeedPhraseQuestion(q), q).toBe(false);
  });

  it("follows the previous question, but a thank-you is small talk", () => {
    expect(shortAnswerReason("detailed", "and for how long?", "How do I treat a minor kitchen burn?")).toBe("health");
    expect(shortAnswerReason("detailed", "thanks, that helps", "How do I treat a minor kitchen burn?")).toBe("smalltalk");
    expect(shortAnswerReason("detailed", "Why did Rome fall?", "Who was Napoleon?")).toBeNull();
    expect(shortAnswerReason("succinct", "How should I store my seed phrase?")).toBeNull();
  });

  it("gives a small model Detailed without D4's always-comply line", () => {
    const d = getPersonality("detailed");
    expect(promptFor(d, false).systemPrompt).toContain("Always do what the user asks");
    expect(promptFor(d, true).systemPrompt).not.toContain("Always do what the user asks");
    expect(promptFor(getPersonality("succinct"), true).systemPrompt).toBe(getPersonality("succinct").systemPrompt);
  });

  it("sends percentages to the calculator, not the library", () => {
    expect(classifyTask("what is 15 percent of 240")).toBe("calculate");
    expect(classifyTask("15% of 240?")).toBe("calculate");
    expect(classifyTask("thank you so much!")).toBe("greeting");
  });
});
