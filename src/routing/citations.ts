/**
 * CT-1 (Prism): a [n] must point at a source that supports its sentence. The
 * models answer from memory and still cite [1] ("Earth's axial tilt causes
 * the seasons [1]" with [1] = Walipini, a greenhouse). A citation stays only
 * when the source contains at least half of the sentence's key words; one
 * pointing past the sources is always dropped. Pure.
 */
import type { RetrievedChunk } from "../rag/retrieve.types";
import { tokenizeTerms } from "./context";

/**
 * A sentence: up to its end mark. A "." followed by a digit is not one: "8.0 billion" split at the dot got
 * its citation inside the number ("8 [1].0 billion"; desktop bench on Vitalik's questions, 21/10).
 */
const SENTENCE = /(?:[^.!?\n]|\.(?=\d))+[.!?]*/g;

/** Share of a cited sentence's key words the source must contain. */
export const CITATION_MIN_SUPPORT = 0.5;
/** Sentences with fewer key words than this are too short to judge: the citation stays. */
const MIN_KEY_TERMS = 2;

const same = (a: string, b: string) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short) && long.length - short.length <= 3;
};

/** tokenizeTerms without a final "e", so "cause" meets "caused"/"causes" ("caus") and "radiate" meets "radiation". */
const terms = (text: string) => tokenizeTerms(text).map((t) => (t.length > 4 && t.endsWith("e") ? t.slice(0, -1) : t));

/**
 * Words an English paraphrase adds around a claim without adding one ("gases like carbon dioxide", "due to",
 * "on the other hand"); as key words they made a faithful paraphrase of a short source fall under the bar
 * (iPhone 13, 28/09: the 1.5B's monsoon and the 4B's greenhouse answers lost their [1]). Word fragments
 * ("re-radiate") too.
 */
const FILLER = new Set(
  (
    "like due often especially typically usually generally mainly primarily commonly both whereas while although though " +
    "however therefore thus hence hand per etc even still yet instead rather within throughout through across among " +
    "upon onto toward towards via around re"
  ).split(" ")
);
const keyTerms = (text: string) => [...new Set(terms(text.replace(/\[\d+\]/g, " ")))].filter((t) => !FILLER.has(t));

/** The sentence a citation at `at` belongs to: back past "." and spaces right before it, then to the previous sentence end. */
function sentenceBefore(text: string, at: number): string {
  let j = at;
  while (j > 0 && /[\s\]\d[]/.test(text[j - 1]) && !/[.!?\n]/.test(text[j - 1])) j--;
  if (j > 0 && /[.!?]/.test(text[j - 1])) j--;
  let start = j;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  return text.slice(start, j);
}

export function citationSupport(sentence: string, source: RetrievedChunk): number {
  const key = keyTerms(sentence);
  if (key.length < MIN_KEY_TERMS) return 1;
  const have = terms(`${source.title} ${source.body}`);
  return key.filter((k) => have.some((h) => same(h, k))).length / key.length;
}

export interface CheckedCitations {
  text: string;
  /** Source numbers removed, in order of appearance. */
  removed: number[];
  /** Source numbers moved to another sentence of their paragraph (relocate), in order of appearance. */
  moved: number[];
}

/**
 * What a citation that closes its paragraph ("A. B. [1]", "A. B [1].") vouches for: the whole paragraph
 * since the previous citation, judged as one claim at the bar for adding a citation (ATTRIBUTION_MIN_SUPPORT):
 * a bigger claim, a higher bar. The 1.5B writes one [1] after a whole explanation; judging only its last
 * sentence ("This cycle keeps Earth warm, essential for life.") dropped it. At the lower bar, loose word
 * overlap passed ("The United States has 50 states. The element with atomic number 50 is tin." with
 * Avogadro: 0.5). Null for a citation inside a paragraph, or one that closes a single sentence.
 */
function paragraphBefore(text: string, at: number, end: number): string | null {
  if (!/^[\s.!?]*(\n|$)/.test(text.slice(end))) return null;
  let start = at;
  while (start > 0 && text[start - 1] !== "\n" && text[start - 1] !== "]") start--;
  const span = text.slice(start, at);
  return (span.match(/[.!?](\s|$)/g) ?? []).length > 1 || /[.!?]\s+\S/.test(span.trim()) ? span : null;
}

/**
 * Where a [n] its own sentence doesn't earn can go instead: the sentence of the same paragraph (since the
 * previous citation) that source n supports best, at the bar for keeping one. The 1.5B writes its [1] after
 * the last sentence ("A black hole is … nothing, not even light, can escape [support 0.64]. They form from
 * massive stars … [1]" [0.11]); dropping it left the supported sentence uncited, and the compact model
 * declined a right answer (desktop bench, 2 of 7 false declines). `segment` is the text before the citation;
 * returns it with " [n]" at that sentence's end, or null when no sentence there earns it.
 */
function relocate(segment: string, n: number, source: RetrievedChunk): string | null {
  const from = Math.max(segment.lastIndexOf("\n"), segment.lastIndexOf("]")) + 1;
  const title = terms(source.title);
  let best: { at: number; end: number; support: number } | null = null;
  for (const m of segment.slice(from).matchAll(SENTENCE)) {
    const key = keyTerms(m[0]);
    // A sentence too short to judge (support 1 by definition) never takes a citation it didn't carry, and the
    // one that does names the source's subject: half the words of "The element with atomic number 50 is tin"
    // are in the Avogadro article ("element", "number"), but it isn't about Avogadro (gate c7a7f17).
    if (key.length < MIN_KEY_TERMS || !key.some((k) => title.some((t) => same(t, k)))) continue;
    const support = citationSupport(m[0], source);
    if (support >= CITATION_MIN_SUPPORT && support > (best?.support ?? 0)) {
      best = { at: from + m.index!, end: from + m.index! + m[0].length, support };
    }
  }
  if (!best) return null;
  const s = /^(.*?)(\s*)([.!?]*)(\s*)$/s.exec(segment.slice(best.at, best.end))!;
  return `${segment.slice(0, best.at)}${s[1]} [${n}]${s[3]}${s[4]}${segment.slice(best.end)}`;
}

export function checkCitations(answer: string, sources: RetrievedChunk[]): CheckedCitations {
  const removed: number[] = [];
  const moved: number[] = [];
  let text = "";
  let last = 0;
  for (const match of answer.matchAll(/\s?\[(\d+)\]/g)) {
    const whole = match[0];
    const at = match.index!;
    const n = Number(match[1]);
    const source = sources[n - 1];
    const bracket = at + whole.indexOf("[");
    const paragraph = source ? paragraphBefore(answer, bracket, at + whole.length) : null;
    const keep =
      !!source &&
      (citationSupport(sentenceBefore(answer, bracket), source) >= CITATION_MIN_SUPPORT ||
        (paragraph !== null && citationSupport(paragraph, source) >= ATTRIBUTION_MIN_SUPPORT));
    const segment = answer.slice(last, at);
    last = at + whole.length;
    if (keep) {
      text += segment + whole;
      continue;
    }
    const elsewhere = source ? relocate(segment, n, source) : null;
    (elsewhere ? moved : removed).push(n);
    text += elsewhere ?? segment;
  }
  text += answer.slice(last);
  const changed = removed.length || moved.length;
  return { text: changed ? text.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ") : answer, removed, moved };
}

export interface AttributedCitations {
  text: string;
  /** Source numbers added, in order of appearance. */
  added: number[];
}

/**
 * Share of a sentence's key words a source must contain for a [n] to be ADDED. Higher than the bar to
 * keep one (CITATION_MIN_SUPPORT): on gate 9ef80f9's real uncited answers, 0.5 would have cited the
 * Post-quantum cryptography article for "…signature algorithms include those based on elliptic curve
 * cryptography (ECC)" (wrong; 0.67), while the monsoon (0.84), greenhouse (0.86) and OQS (1.0) sentences
 * clear 0.75.
 */
export const ATTRIBUTION_MIN_SUPPORT = 0.75;

/**
 * The honest inverse of checkCitations (Boar, gate 9ef80f9: the 4B answered the monsoon from the Monsoon
 * source and the 1.5B the greenhouse effect from its article, without a [n]): a sentence without a
 * citation gets the [n] of the source that supports it, by the same measure at a higher bar. A sentence
 * too short to judge never gets one (checkCitations keeps those; adding needs real support).
 */
export function attributeCitations(answer: string, sources: RetrievedChunk[]): AttributedCitations {
  const added: number[] = [];
  if (!sources.length) return { text: answer, added };
  const text = answer.replace(SENTENCE, (sentence: string, at: number) => {
    if (/\[\d+\]/.test(sentence)) return sentence;
    // A citation right after the sentence's punctuation ("… Zone. [1]") is its own (Prism CIT-2: "[1]. [1]").
    if (/^\s*\[\d+\]/.test(answer.slice(at + sentence.length))) return sentence;
    if (keyTerms(sentence).length < MIN_KEY_TERMS) return sentence;
    // A heading or a bold title line ("## Greenhouse effect", "**Causes:**") names a topic, it claims nothing.
    if (/^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/.test(sentence)) return sentence;
    let best = -1;
    let bestSupport = 0;
    sources.forEach((source, i) => {
      const support = citationSupport(sentence, source);
      if (support >= ATTRIBUTION_MIN_SUPPORT && support > bestSupport) {
        best = i;
        bestSupport = support;
      }
    });
    if (best < 0) return sentence;
    added.push(best + 1);
    const m = /^(.*?)(\s*)([.!?]*)(\s*)$/s.exec(sentence)!;
    return `${m[1]} [${best + 1}]${m[3]}${m[4]}`;
  });
  return { text: dedupeCitations(text), added };
}

/** The same [n] twice around one sentence end ("… Zone [1]. [1]", "… [1] [1].") is shown once (Prism CIT-2). */
export function dedupeCitations(text: string): string {
  return text.replace(/\[(\d+)\][ \t]*([.!?]?)[ \t]*\[\1\]/g, "[$1]$2");
}
