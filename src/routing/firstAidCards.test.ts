import { describe, it, expect } from "vitest";
import { isSnakebiteFirstAid, snakebiteFirstAidCard } from "./firstAidCards";
import { riskyHealthInstruction } from "./context";

describe("snakebite first-aid card (WHO text, Boar-approved; SAFETY)", () => {
  it("fires on a snakebite first-aid question, EN and PT", () => {
    for (const q of [
      "fui picado por uma cobra, o que faço?",
      "snake bit my friend, what do I do",
      "Acabei de ser picado por uma cobra numa trilha, a duas horas da estrada mais próxima. O que eu faço agora?",
      "I just got bitten by a snake while hiking, two hours from the nearest road. What do I do right now?",
    ]) expect(isSnakebiteFirstAid(q), q).toBe(true);
  });
  it("does not fire on a question about snakes", () => {
    for (const q of ["cobras são venenosas no Brasil?", "Are rattlesnakes dangerous?", "How many snake species are there?", "Tell me about snakebite statistics in India"]) expect(isSnakebiteFirstAid(q), q).toBe(false);
  });
  it("the card: the approved text, the source, the emergency line; no contested or dangerous step", () => {
    const pt = snakebiteFirstAidCard("fui picado por uma cobra, o que faço?", true);
    expect(pt).toMatch(/^Picada de cobra, primeiros socorros: afaste-se da cobra e não tente pegá-la nem matá-la\. Mantenha a pessoa parada e calma/);
    expect(pt).toMatch(/NÃO use torniquete apertado, NÃO corte o local e NÃO chupe o veneno nem passe produtos químicos\./);
    expect(pt).toMatch(/Fonte: OMS, perguntas e respostas sobre picada de cobra \(2019\)\./);
    expect(pt).toMatch(/192/);
    const en = snakebiteFirstAidCard("snake bit my friend in Thailand, what do I do", false);
    expect(en).toMatch(/Source: WHO, questions and answers on snakebite envenoming \(2019\)\./);
    expect(en).toMatch(/Emergency — Thailand: police 191, ambulance 1669/);
    for (const text of [pt, en]) {
      expect(text).not.toMatch(/\b(immobiliz\w*|imobiliz\w*|ice|gelo|heart|ring|rings|anel|an[ée]is|watch|rel[óo]gio)\b|coração/i);
      expect(riskyHealthInstruction(text)).toBeNull();
    }
  });
});
