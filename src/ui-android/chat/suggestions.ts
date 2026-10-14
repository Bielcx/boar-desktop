/**
 * Which suggested questions (chat.suggestions.q1..) the empty state offers,
 * per model and UI language: only those the model answered correctly and
 * safely in that language, 3 of 3 seeds, outside the test sets.
 *
 * Re-validate with Sextant when a model or a question changes, then bump
 * `version` and `validatedAt`. A model not listed gets no suggestions.
 */
export const SUGGESTION_VALIDATION = {
  version: 3,
  validatedAt: "2026-09-27",
  // v1: q1-q4. v2 (Sextant 20463ed): q5-q7 on the builtin corpus, 3 seeds, graded by hand.
  // v3 (Boar/Bramble 27/09): q5 "What causes the monsoon?" and q6 "Why do earthquakes happen near plate
  // boundaries?" retired: the builtin corpus holds only the lead paragraph of "Monsoon" and "Plate
  // tectonics", which says neither. Replaced by q8/q9, which the lead itself answers.
  // Sextant v3 (integration 50d44a1, builtin only, seeds 42/7/1234): q8 EN passes on both models (lead
  // cited); q8 PT fails ("monção" doesn't reach Monsoon); q9 fails in both languages (EN cited 2/3,
  // PT's on-topic source dropped by the guard). Rechecked on 98a47b4: the same (8c66bc2), q9 stays out.
  // On d7de156 with the PT lexicon (519b4c2): q8 PT finds and cites Monsoon, but answers with the English
  // lead and no PT notice, failing the language rule. With Tusk 29d7e52 (candidate 7fd3242: the passage
  // opens with "Da fonte offline (em inglês):") and "monção" in the lexicon (8fdb71c): PASS 3/3 on both
  // models (Sextant 7566472). Needs 7fd3242 in the build.
  evidence: "eval/results/suggestions/verdicts.v1.json + v2 + v3 (feat/eval-frontier 4655cbb, rechecks 8c66bc2, 519b4c2, 7566472)",
  byModel: {
    "qwen3-4b-instruct-2507-q4km": { en: ["q1", "q2", "q3", "q4", "q7", "q8"], pt: ["q1", "q2", "q3", "q4", "q7", "q8"] },
    // 1.5B PT: q3 fails the source check (answer shows "Cold", "Absolute zero"); only q8 (v3) so far.
    "qwen2.5-1.5b-instruct-q4km": { en: ["q1", "q2", "q3", "q4", "q7", "q8"], pt: ["q8"] },
  } as Record<string, Record<"en" | "pt", string[]>>,
};

/**
 * Where each suggestion's answer comes from (Boar/Prism RT-1: "Why do we have
 * seasons on Earth?" retrieved Walipini and Hot weather). A suggestion shows
 * only when one of its `corpus` ids is installed ("builtin" = the 300-topic
 * base shipped in the app, always there), and `expect` lists title words of an
 * on-topic source. Sextant's test: asking the question with only that corpus
 * must return a source whose title contains one of them.
 *
 * Checked by title against the shipped corpora (26/09): the builtin has
 * "Pandemic", "Monsoon", "Plate tectonics", "Greenhouse effect"; neither
 * builtin nor corpus-standard/full has "Season" or "Fahrenheit" (standard is
 * a random Wikipedia sample). wiki-vital5 (Bramble, app search): seasons →
 * Season 1st, nosebleed → Nosebleed 1st, Fahrenheit 3rd after Kelvin and
 * Celsius. Photosynthesis and vaccines are left out: the app's EVAL_SET asks
 * them (Sextant's "outside the test sets" rule). New keys (q5-q7) show once a
 * model's list in SUGGESTION_VALIDATION includes them.
 */
export interface SuggestionSource {
  key: string;
  corpus: string[];
  expect: string[];
  /**
   * Languages where Sextant's check found an on-topic source in the app's top-3 (27/09: every
   * English one; in Portuguese only q4 and q6 until Bramble's PT-1 fixes Portuguese search).
   */
  langs: ("en" | "pt")[];
}

export const SUGGESTION_SOURCES: SuggestionSource[] = [
  // q1: off in English too while the search brings "Year" into its top-3 (Sextant, 27/09).
  { key: "q1", corpus: ["wiki-vital5"], expect: ["Season", "Axial tilt", "Autumn", "Winter", "Summer", "Spring"], langs: [] },
  { key: "q2", corpus: ["builtin"], expect: ["Pandemic", "Epidemic"], langs: ["en"] },
  { key: "q3", corpus: ["wiki-vital5"], expect: ["Fahrenheit", "Celsius", "Temperature"], langs: ["en"] },
  { key: "q4", corpus: ["boar-preparedness", "wiki-vital5"], expect: ["Nosebleed", "Epistaxis", "Emergency bleeding control"], langs: ["en", "pt"] },
  // q8/q9 (v3): asked of what the builtin lead says. Top-3 (Sextant): both languages (q8 PT with "monção").
  { key: "q8", corpus: ["builtin"], expect: ["Monsoon"], langs: ["en", "pt"] },
  { key: "q9", corpus: ["builtin"], expect: ["Plate tectonics"], langs: ["en", "pt"] },
  { key: "q7", corpus: ["builtin"], expect: ["Greenhouse effect", "Climate change"], langs: ["en"] },
];

/**
 * Keys whose on-topic source is installed and was found in that language. `installed` holds
 * knowledge ids; "builtin" is implied.
 */
export function coveredSuggestions(keys: string[], installed: Iterable<string>, lang: "en" | "pt" = "en"): string[] {
  const have = new Set<string>(["builtin", ...installed]);
  const byKey = new Map(SUGGESTION_SOURCES.map((s) => [s.key, s]));
  return keys.filter((k) => {
    const src = byKey.get(k);
    return !!src && src.langs.includes(lang) && src.corpus.some((c) => have.has(c));
  });
}

/** What the empty chat offers: validated for the model and language, and covered by the installed knowledge. */
export function suggestionsFor(modelId: string | undefined, language: string | undefined, installed: Iterable<string> = []): string[] {
  if (!modelId) return [];
  const byLang = SUGGESTION_VALIDATION.byModel[modelId];
  if (!byLang) return [];
  const lang = language?.startsWith("pt") ? "pt" : "en";
  return coveredSuggestions(byLang[lang] ?? [], installed, lang);
}

/** Below this many suggestions, the empty chat adds "Add a knowledge pack for more topics" (Iris). */
export const MIN_SUGGESTIONS = 3;

export function showsKnowledgeHint(count: number): boolean {
  return count < MIN_SUGGESTIONS;
}
