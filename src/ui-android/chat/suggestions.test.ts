import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_IDEAS, coveredSuggestions, ideasFor, IDEAS_SHOWN, showsKnowledgeHint, SUGGESTION_SOURCES, suggestionsFor } from "./suggestions";

const ALL = ["wiki-vital5", "boar-preparedness"];

describe("suggestionsFor", () => {
  it("offers only what each model passed in each language (with every corpus installed)", () => {
    expect(suggestionsFor("qwen3-4b-instruct-2507-q4km", "en", ALL)).toEqual(["q2", "q3", "q4", "q7", "q8"]);
    expect(suggestionsFor("qwen2.5-1.5b-instruct-q4km", "en", ALL)).toEqual(["q2", "q3", "q4", "q7", "q8"]);
  });

  it("in Portuguese offers only what passed both checks (source in PT + answer), Sextant 27/09", () => {
    // Fewer than 3 in Portuguese: filled from the other model's, which are the same two at most.
    expect(suggestionsFor("qwen3-4b-instruct-2507-q4km", "pt", ALL)).toEqual(["q4", "q8"]);
    expect(suggestionsFor("qwen3-4b-instruct-2507-q4km", "pt")).toEqual(["q8"]);
    expect(suggestionsFor("qwen2.5-1.5b-instruct-q4km", "pt-BR", ALL)).toEqual(["q8", "q4"]);
  });

  it("v3 (Sextant 4655cbb, 7566472): q5/q6 retired; q8 in both languages; q9 on no model until it passes", () => {
    for (const m of ["qwen3-4b-instruct-2507-q4km", "qwen2.5-1.5b-instruct-q4km"])
      for (const lang of ["en", "pt"]) {
        const offered = suggestionsFor(m, lang, ALL);
        for (const k of ["q5", "q6", "q9"]) expect(offered, `${m} ${lang} ${k}`).not.toContain(k);
        expect(offered.includes("q8"), `${m} ${lang} q8`).toBe(true);
      }
    expect(SUGGESTION_SOURCES.map((x) => x.key).sort()).toEqual(["q1", "q2", "q3", "q4", "q7", "q8", "q9"]);
  });

  it("fills a model that wasn't validated (a Hugging Face model) from the other models' ideas; none with no model", () => {
    expect(suggestionsFor("hf-someone-model-gguf", "en", ALL)).toEqual(["q2", "q3", "q4", "q7", "q8"]);
    expect(suggestionsFor("hf-someone-model-gguf", "pt")).toEqual(["q8"]);
    expect(suggestionsFor(undefined, "en", ALL)).toEqual([]);
  });
});

describe("coveredSuggestions (RT-1)", () => {
  it("hides a question whose on-topic source isn't installed ('seasons' on the builtin base)", () => {
    expect(suggestionsFor("qwen3-4b-instruct-2507-q4km", "en")).toEqual(["q2", "q7", "q8"]);
    expect(suggestionsFor("qwen3-4b-instruct-2507-q4km", "en", ["boar-preparedness"])).toEqual(["q2", "q4", "q7", "q8"]);
  });

  it("keeps unknown keys out", () => {
    expect(coveredSuggestions(["q2", "zz"], [])).toEqual(["q2"]);
  });

  it("every builtin-covered suggestion has an on-topic title in the shipped builtin corpus", () => {
    const titles: string[] = JSON.parse(readFileSync(join(__dirname, "../../../assets/corpus/corpus.json"), "utf8")).map(
      (d: { title: string }) => d.title
    );
    for (const s of SUGGESTION_SOURCES.filter((x) => x.corpus.includes("builtin"))) {
      expect(s.expect.some((w) => titles.includes(w)), s.key).toBe(true);
    }
  });

  it("no builtin suggestion asks about a topic the app's EVAL_SET uses (Sextant: outside the test sets)", () => {
    const evalSource = readFileSync(join(__dirname, "../../eval/evalSet.ts"), "utf8");
    const evalTitles = [...evalSource.matchAll(/expectedKbTitles: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    for (const s of SUGGESTION_SOURCES) {
      for (const w of s.expect) expect(evalTitles, `${s.key} ${w}`).not.toContain(w);
    }
  });

  it("every suggestion has its text and topic in EN and PT", () => {
    for (const lang of ["en", "pt"]) {
      const chat = JSON.parse(readFileSync(join(__dirname, `../../i18n/locales/${lang}.json`), "utf8")).chat;
      for (const s of SUGGESTION_SOURCES) {
        expect(chat.suggestions[s.key], `${lang} ${s.key}`).toBeTruthy();
        expect(chat.suggestionTopics[s.key], `${lang} topic ${s.key}`).toBeTruthy();
      }
    }
  });
});

describe("showsKnowledgeHint (Iris)", () => {
  it("adds the knowledge-pack card below three suggestions, including none", () => {
    expect([0, 1, 2, 3, 4].map(showsKnowledgeHint)).toEqual([true, true, true, false, false]);
  });
});

describe("ideasFor (a different few per new chat)", () => {
  it("draws 5 from the validated ideas plus the evaluations' short questions, none twice", () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const a = ideasFor("qwen3-4b-instruct-2507-q4km", "en", ALL, random);
    const b = ideasFor("qwen3-4b-instruct-2507-q4km", "en", ALL, random);
    expect(a).toHaveLength(IDEAS_SHOWN);
    expect(new Set(a).size).toBe(IDEAS_SHOWN);
    expect(a).not.toEqual(b);
    const pool = new Set([...suggestionsFor("qwen3-4b-instruct-2507-q4km", "en", ALL), ...BENCH_IDEAS]);
    for (const k of [...a, ...b]) expect(pool.has(k), k).toBe(true);
    expect(ideasFor(undefined, "en", ALL)).toEqual([]);
  });

  it("has every idea's question and topic in both languages", () => {
    for (const lang of ["en", "pt"]) {
      const chat = JSON.parse(readFileSync(join(__dirname, `../../i18n/locales/${lang}.json`), "utf8")).chat;
      for (const k of BENCH_IDEAS) {
        expect(chat.suggestions[k], `${lang} ${k}`).toBeTruthy();
        expect(chat.suggestionTopics[k], `${lang} ${k}`).toBeTruthy();
      }
    }
  });
});
