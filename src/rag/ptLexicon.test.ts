import { describe, it, expect } from "vitest";
import { englishNamesIn, looksPortuguese, normalizeKey, singularsPt } from "./ptLexicon";

const lexicon = {
  "estacao do ano": "Season",
  terra: "Earth",
  "efeito estufa": "Greenhouse effect",
  moncao: "Monsoon",
  "fusao nuclear": "Nuclear fusion",
  "fissao nuclear": "Nuclear fission",
  vacina: "Vaccine",
  "sistema imunologico": "Immune system",
  "sangramento nasal": "Nosebleed",
  queimadura: "Burn",
  ano: "Year",
};

describe("ptLexicon", () => {
  it("normalizes keys like the lexicon builder", () => {
    expect(normalizeKey("Estação do  ano")).toBe("estacao do ano");
    expect(normalizeKey("Mercúrio (planeta)")).toBe("mercurio");
  });

  it("makes Portuguese plurals singular", () => {
    expect(singularsPt("estacoes")).toContain("estacao");
    expect(singularsPt("moncoes")).toContain("moncao");
    expect(singularsPt("vacinas")).toContain("vacina");
  });

  it("tells Portuguese questions from English ones", () => {
    expect(looksPortuguese("Por que existem estações do ano na Terra?")).toBe(true);
    expect(looksPortuguese("Como estancar um sangramento nasal?")).toBe(true);
    expect(looksPortuguese("Como o efeito estufa aquece a Terra?")).toBe(true);
    expect(looksPortuguese("O que causa as monções?")).toBe(true);
    expect(looksPortuguese("If it is 3 PM in Tokyo, what time is it in São Paulo?")).toBe(false);
    expect(looksPortuguese("Recommend some vegetarian restaurants in Medellín")).toBe(false);
    expect(looksPortuguese("Why do we have seasons on Earth?")).toBe(false);
    expect(looksPortuguese("How do vaccines train the immune system?")).toBe(false);
  });

  it("finds the English names a Portuguese question mentions, longest first, each word once", () => {
    expect(englishNamesIn("Por que existem estações do ano na Terra?", lexicon)).toEqual(["Season", "Earth"]);
    expect(englishNamesIn("Como o efeito estufa aquece a Terra?", lexicon)).toEqual(["Greenhouse effect", "Earth"]);
    expect(englishNamesIn("O que causa as monções?", lexicon)).toEqual(["Monsoon"]);
    expect(englishNamesIn("Como as vacinas treinam o sistema imunológico?", lexicon)).toEqual(["Immune system", "Vaccine"]);
    expect(englishNamesIn("Como estancar um sangramento nasal?", lexicon)).toEqual(["Nosebleed"]);
    expect(englishNamesIn("Qual é a capital da França?", lexicon)).toEqual([]);
    expect(englishNamesIn("Quanto é 30 °C em Fahrenheit?", { ...lexicon, "grau fahrenheit": "Fahrenheit" })).toEqual(["Fahrenheit"]);
    // Short common nouns aren't names; long or capitalized ones are.
    const generic = { ...lexicon, hora: "Hour", braco: "Arm", filho: "Son", tbilisi: "Tbilisi", "monção": "Monsoon" };
    // A short question's content word is its subject, however short, with or without the accent, singular or plural.
    for (const q of ["O que é uma monção?", "O que é uma moncao?", "O que causa as monções?", "o que sao moncoes"]) {
      expect(englishNamesIn(q, generic), q).toEqual(["Monsoon"]);
    }
    expect(englishNamesIn("Meu filho queimou o braço há uma hora. O que eu faço?", generic)).toEqual([]);
    expect(englishNamesIn("Onde comer em Tbilisi?", generic)).toEqual(["Tbilisi"]);
    expect(englishNamesIn("Como tratar uma queimadura?", lexicon)).toEqual(["Burn"]);
    // Same key without accents, different words: the spelling as written decides.
    const fruit = { ...lexicon, roma: "Rome", "romã": "Pomegranate" };
    expect(englishNamesIn("Onde comer bem em Roma?", fruit)).toEqual(["Rome"]);
    // "romã" never becomes Rome (and a short lower-case word isn't a name on its own anyway).
    expect(englishNamesIn("Qual é o suco de romã mais saudável?", fruit)).toEqual([]);
    expect(englishNamesIn("Qual é o suco de Romã mais saudável?", fruit)).toEqual(["Pomegranate"]);
  });
});
