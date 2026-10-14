/**
 * Sentence selection for src/rag/passages.ts, pure so it's unit-testable.
 */
import type { Passage, PassageSentence } from "./passages.types";

/** A question term: word-start prefixes that count as it (a porter stem's surface prefix, or word forms) and its weight. */
export interface WeightedTerm {
  prefixes: string[];
  weight: number;
}

// Abbreviations after which a period doesn't end a sentence.
const ABBREVIATIONS = new Set(
  "mr mrs ms dr prof st jr sr vs etc e.g i.e al fig no vol approx c ca inc ltd co corp gen col lt sgt rev mt ft u.s u.k".split(" ")
);

/** Splits prose into sentences; list items and lines are separate sentences. Returns [start, end) offsets. */
export function splitSentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const push = (s: number, e: number) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push([s, e]);
  };
  let start = 0;
  const re = /([.!?])["”’)\]]*\s+(?=["“‘(\[]?[\p{Lu}\p{N}])|\n+/gu;
  for (const m of text.matchAll(re)) {
    const end = m.index! + m[0].length;
    if (m[1]) {
      const before = text.slice(start, m.index! + 1);
      const lastWord = (before.match(/([\p{L}.]+)\.$/u)?.[1] ?? "").toLowerCase();
      // "U.S." or "J." (an initial) or a known abbreviation: not a sentence end
      if (ABBREVIATIONS.has(lastWord.replace(/\.$/, "")) || /^\p{L}$/u.test(lastWord) || /^(\p{L}\.)+\p{L}$/u.test(lastWord)) continue;
    }
    push(start, end);
    start = end;
  }
  push(start, text.length);
  return out;
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function hasPrefixAtBoundary(prefix: string, low: string): boolean {
  for (let i = low.indexOf(prefix); i >= 0; i = low.indexOf(prefix, i + 1)) {
    if (!isWordChar(low[i - 1])) return true;
  }
  return false;
}

/** Share of the question's term weight found in `text`, 0..1. */
export function termCoverage(text: string, terms: WeightedTerm[]): number {
  const total = terms.reduce((s, t) => s + t.weight, 0);
  if (!total) return 0;
  const low = text.toLowerCase();
  return terms.filter((t) => t.prefixes.some((p) => hasPrefixAtBoundary(p, low))).reduce((s, t) => s + t.weight, 0) / total;
}

/**
 * The passage's best `max` sentences for the question, in document order.
 * A lead passage always keeps its first sentence (usually the definition).
 * Sentences that share no question term are dropped otherwise.
 */
export function selectSentences(text: string, terms: WeightedTerm[], max: number, isLead: boolean): PassageSentence[] {
  const spans = splitSentences(text);
  const scored = spans.map(([s, e], i) => ({ i, text: text.slice(s, e), score: Math.round(termCoverage(text.slice(s, e), terms) * 1000) / 1000 }));
  const keep = scored
    .filter((x) => x.score > 0 || (isLead && x.i === 0))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max);
  if (isLead && scored.length && !keep.some((x) => x.i === 0)) keep[keep.length - 1] = scored[0];
  return keep.sort((a, b) => a.i - b.i).map(({ text, score }) => ({ text, score }));
}

/** First paragraph of an article's text: after the "# Title" heading and infobox facts, whole. */
export function leadParagraph(articleText: string): string {
  for (const par of articleText.split("\n\n")) {
    const p = par.trim();
    if (!p || p.startsWith("#") || p.startsWith("Key facts:")) continue;
    return p;
  }
  return "";
}

/** Keeps passages in rank order until the sentence budget is spent; a passage that doesn't fit is trimmed to what does. */
export function applyCharBudget(passages: Passage[], budget: number): Passage[] {
  const out: Passage[] = [];
  let used = 0;
  for (const p of passages) {
    const sentences: PassageSentence[] = [];
    for (const s of p.sentences) {
      if (used + s.text.length > budget) break;
      sentences.push(s);
      used += s.text.length + 1;
    }
    if (!sentences.length) break;
    out.push({ ...p, sentences, text: sentences.map((s) => s.text).join(" ") });
  }
  return out;
}
