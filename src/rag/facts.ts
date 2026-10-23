/**
 * FACTS (coordinator arm, 2026-10-06; criterion rnd/research/coordinator/arms/facts/FACTS-criterion.md 4328960e…):
 * a structured-knowledge instant answer from a compact offline table (Wikidata, CC0; facts.v1.json).
 *
 * Fires only when (a) the question names ≥ 1 table entity by label/alias, found with the same word n-grams the pack
 * title lookup uses (wikiPack.titleCandidates), and (b) its wording matches exactly one property template of the
 * lexicon below. One entity → the value with unit, "as of" year and a source line; two entities + a comparison word →
 * a computed verdict. Anything else (no entity, 0 or ≥ 2 templates, an unsupported slot, an entity without the value,
 * 3+ entities) → null and the normal path. English only; the caller keeps it off health/emergency messages.
 * r2 (DATA-REVIEW.md §4): the table is gated at build time (no founding year for countries/cities, population only
 * if dated ≥ 2020, no former/proposed/unbuilt entities or out-of-range values, nickname aliases removed); here a name
 * must be typed capitalised word by word, and a name with two entities (or a known outside homonym) is not answered.
 * r3 (FACTS-RECALL.md): a one-word country or capital name may be typed lowercase (not the common-word risk list);
 * aliases China / UK / Britain / US / USA / America and "the X" aliases ("the Amazon"); "size of" and "bigger/larger/
 * smaller than" ask for area; a name glued to an unknown capitalised word (Paris Hilton) or a compound property word
 * (area code) does not fire; a population dated before 2023 prints "(dated YEAR)".
 * r4 (FACTS-r4-criterion.md): a lowercase or mixed-case name of ≥ 2 words resolves when, case-folded, it is the label or
 * alias of exactly one entity and none of its words is on the risk list ("mont blanc", "the petronas towers"); the
 * tokens thw/teh/hte/tje/th read as "the" only right before a name that resolves ("thw netherlands").
 * r5 (FACTS-r5-criterion.md 54ab7a1b…): (A) every resolved name, any casing, needs an allowed word on BOTH sides (after
 * skip-words, punctuation and numbers): edge, question/function word, property word, hedge/time word, unit, comparison
 * connector, or a word of another resolved name; any other word ("paris hilton", "london broil") → no answer. (B) "whats /
 * hows / wheres …" and "size of / capital of / population of / elevation of / height of / length of …" are questions
 * without "?". (C) a multi-word name that, case-folded, is one label/alias of one entity resolves even with a risk-list word.
 * r6 (FACTS-r6-criterion.md 60027d01…, B: five trigger fixes, nothing else): (1) the opening word whta/waht/wat → what,
 * hwo → how, whats' → whats; (2) "official language(s) of X" and "continent of X" are questions without "?"; (3) "what
 * continent is X in/on" for a place answers with its one country's continent; (4) "what country/countries surround(s) X" asks
 * for borders; (5) "which is taller/higher, X or Y" / "is X taller/higher than Y": when each side is, case-folded, exactly
 * the label/alias of one entity and both are mountains or both are buildings/towers/dams, the heights are compared.
 */
import table from "./facts.v1.json";
import { titleCandidates } from "./wikiPack";

type Num = [number, number | null]; // value, "as of" year (point in time) or null
export interface FactEntity {
  q: string; // Wikidata id
  n: string; // English label
  a?: string[]; // English aliases
  k: string; // kind: country | city | lake | river | mountain | building (incl. towers) | dam | event | award | other
  d?: string; // English description
  pop?: Num;
  area?: number; // km²
  elev?: number; // m
  height?: number; // m
  len?: number; // km
  depth?: number; // m
  cap?: string[];
  cur?: string[];
  lang?: string[];
  cont?: string[];
  bord?: string[];
  plug?: string[];
  volt?: number[];
  hz?: number[];
  inc?: string; // "YYYY-MM-DD" or "YYYY"
  end?: string;
  loc?: string[];
  win?: Record<string, string[]>; // year → winners
  ctry?: string[]; // country (P17) of a place
  t?: string[]; // instance of (P31), mountains only
  emerg?: [string, string][]; // r8: emergency phone numbers (P2852) and their service (P366), countries only
}
interface Table { snapshot: string; entities: FactEntity[] }
const T = table as unknown as Table;

export type FactTemplate =
  | "population" | "area" | "capital" | "currency" | "languages" | "continent" | "borders"
  | "height" | "length" | "depth" | "dates" | "electricity" | "host" | "winner" | "emergency";

/** Property lexicon: the wording that asks for each template (lowercase; whole words/phrases). */
export const FACT_LEXICON: Record<FactTemplate, string[]> = {
  population: ["population", "populous", "inhabitants", "residents", "how many people", "more people", "fewer people", "less people", "people live", "people living"],
  area: ["area", "how big", "size of", "square kilometres", "square kilometers", "square km", "sq km", "km2", "km²", "square miles", "sq mi"],
  capital: ["capital", "capital city"],
  currency: ["currency", "currencies"],
  languages: ["language", "languages", "official language", "official languages", "spoken"],
  continent: ["continent", "which continent"],
  borders: ["border", "borders", "bordering", "neighbouring countries", "neighboring countries", "neighbours", "neighbors"],
  height: ["how high", "how tall", "height", "elevation", "taller", "higher", "tallest", "highest"],
  length: ["how long is", "how long are", "length", "longer", "longest", "km long", "miles long"],
  depth: ["how deep", "depth", "deepest", "deeper", "deep"],
  dates: ["built", "founded", "established", "constructed", "erected", "inception", "came down", "come down", "fell", "fall of", "torn down", "demolished", "dissolved"],
  emergency: ["emergency number", "emergency numbers", "emergency phone number", "emergency telephone number", "emergency services number", "ambulance number", "police number", "fire brigade number", "fire department number", "number for an ambulance", "number for the police", "number for emergencies", "number to call in an emergency"],
  electricity: ["plug", "plugs", "plug type", "socket", "sockets", "outlet", "outlets", "voltage", "volts", "mains", "adapter", "adaptor"],
  host: ["host", "hosted", "hosting", "held"],
  winner: ["won", "win", "winner", "winners", "received", "awarded", "laureate"],
};

/** Slots the table cannot answer, and explanation wording: any of these → no fire (the model answers). */
const VETO = [
  "density", "densely", "gdp", "economy", "time zone", "timezone", "driving side", "drive on", "climate", "weather", "religion",
  "president", "prime minister", "leader", "government", "history", "historically", "known for", "why", "explain", "describe",
  "overview", "tell me about", "essentials", "key facts", "how did", "independent", "independence", "safe", "sick", "sickness",
  "danger", "dangerous", "visa", "flight", "take", "stay", "per capita",
];
/** r3: comparative wording that asks for area only when no other property is named ("Which is bigger, Canada or the US?"). */
const WEAK_AREA = ["bigger than", "larger than", "smaller than", "which is bigger", "which is larger"];
/** r3: compound phrases whose property word is not the property ("area code", "area of expertise"): removed before matching. */
const STOP_PHRASES = [
  "area code", "area codes", "area of expertise", "area of study", "area of interest", "area of focus", "area of research",
  "capital letter", "capital letters", "capital gains", "capital punishment",
];
const COMPARE = ["more", "less", "fewer", "than", "bigger", "larger", "smaller", "higher", "taller", "longer", "shorter", "deeper", "shallower", "or", "compare", "compared", "versus", "vs"];
const GREATER = ["more", "bigger", "larger", "higher", "taller", "longer", "deeper"];
const LESSER = ["less", "fewer", "smaller", "lower", "shorter", "shallower"];
const YES_NO = /^(is|are|does|do|did|has|have|was|were|can|could|would|will)\b/i;
const QUESTION = /\?\s*$|^(what|which|who|when|where|how|is|are|does|do|did|has|have|was|were|can|could|would|will|if|tell|give|list|name)\b/i;
/** r5 rule B (FACTS-r5-criterion.md B): question openers typed without "?" ("whats the capital of the philippines"). */
const QUESTION_OPENERS = /^(whats|what['’]s|hows|how['’]s|wheres|where['’]s)(?![\p{L}\p{N}])|^(size|capital|population|elevation|height|length) of\b/iu;
/** r6 fix 1: typos of the opening "what" / "how" (exact list), read as the word they stand for. */
const OPENER_TYPOS: Array<[RegExp, string]> = [[/^(whta|waht|wat)(?![\p{L}\p{N}'’])/iu, "what"], [/^hwo(?![\p{L}\p{N}'’])/iu, "how"], [/^whats['’](?![\p{L}\p{N}])/iu, "whats"]];
/** r6 fix 2: property-first openers typed without "?" ("official language of iran", "continent of kenya"). */
const R6_OPENERS = /^(official languages?|continent) of\b/iu;
/** r6 fix 3: "what continent is X in/on" (a place: answered with its country's continent). */
const R6_CONTINENT = /^(what|which) continent (is|are)\b.*\b(in|on)\s*\??\s*$/iu;
/** r6 fix 4: "what country/countries border(s)/surround(s) X" asks for borders. */
const R6_SURROUND = /^(what|which) (country|countries) (?:surround|surrounds)\b/iu;
/** r6 fix 5: the two height-comparison frames; each side must be one whole name. */
const R6_TALLER = [
  /^(?:which|what)(?: one)? is (?:taller|higher)\s*[,:]?\s+(?:the\s+)?(.+?)\s+or\s+(?:the\s+)?(.+?)\s*\??\s*$/iu,
  /^is (?:the\s+)?(.+?) (?:taller|higher) than (?:the\s+)?(.+?)\s*\??\s*$/iu,
];
/** r6 fix 5: kinds compared by height in those frames (a mountain with a mountain, a structure with a structure). */
const TALL_CLASS: Record<string, string> = { mountain: "mountain", building: "structure", dam: "structure" };

const has = (low: string, cue: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "u").test(low);

/** r3: everyday short names the Wikidata aliases lack (or the r2 nickname gate removed). */
const R3_ALIASES: Record<string, string[]> = {
  Q148: ["China"],
  Q145: ["UK", "U.K.", "the UK", "Britain"],
  Q30: ["US", "U.S.", "USA", "the USA", "America"],
  Q3783: ["the Amazon"],
};
/** r3: one-word country/capital names that are also common words, first names or part of other places: lowercase never resolves. */
const LOWER_RISK = new Set([
  "georgia", "turkey", "chad", "jordan", "guinea", "chile", "china", "america", "us", "wellington", "victoria", "sofia",
  "israel", "santiago", "kingston", "nice", "reading", "male", "malé",
]);
/** r4 rule 2: typos of "the", read as "the" only when a resolved name follows right after. */
const THE_TYPOS = /(?<![\p{L}\p{N}'’.-])(thw|teh|hte|tje|th)(?![\p{L}\p{N}'’.-])/gu;
/** r3: r3 aliases that may be typed lowercase ("what currency does the uk use"). */
const LOWER_ALIASES = ["uk", "u.k", "britain", "usa", "u.s"];
/** r3: a lowercase name right after one of these is part of another place ("south sudan", "new mexico"): no answer. */
const MODIFIERS = new Set(["north", "south", "east", "west", "northern", "southern", "eastern", "western", "central", "new", "latin", "equatorial", "american", "papua", "upper", "lower", "great", "french", "british", "dutch"]);
/*
 * r5 rule A allowlists (FACTS-r5-criterion.md A). The word right before and right after a resolved name, after skipping
 * R5_SKIP words, punctuation and numbers, must be absent (edge) or in one of these sets, or a word of another resolved name.
 */
/** Skipped when looking for a name's neighbour (criterion A, exact list). */
const R5_SKIP = new Set(["the", "a", "an", "of", "in", "at", "on", "for", "to", "and", "or"]);
/** Question words: wh-words, auxiliaries/modals, pronouns, closed-class function words, and question-frame verbs. */
const R5_QUESTION = new Set([
  "what", "whats", "what's", "which", "who", "whom", "whose", "when", "where", "wheres", "where's", "why", "how", "hows", "how's",
  "is", "isn't", "are", "aren't", "was", "wasn't", "were", "weren't", "am", "be", "been", "being", "does", "doesn't", "do", "don't",
  "did", "didn't", "has", "have", "had", "having", "can", "could", "would", "will", "shall", "should", "may", "might", "must",
  "i", "i'm", "you", "we", "they", "he", "she", "it", "it's", "its", "their", "there", "there's", "this", "that", "these", "those",
  "me", "my", "your", "our", "us", "if", "tell", "give", "list", "name", "show", "know", "wonder", "by", "with", "from", "into",
  "as", "so", "but", "not", "no", "yes", "any", "some", "all", "both", "each", "also", "just", "really", "very", "much", "many",
  "more", "most", "less", "fewer", "then", "compare", "above", "below", "over", "under", "up", "down",
  "use", "uses", "used", "using", "speak", "speaks", "spoken", "speaking", "live", "lives", "living", "located",
  "stand", "stands", "stood", "put", "placed",
]);
/** Property lexicon (criterion A list, every one-word cue of FACT_LEXICON, and their superlatives / feature points). */
const R5_PROPERTY = new Set([
  "tall", "high", "big", "long", "deep", "population", "people", "capital", "currency", "language", "languages", "official",
  "continent", "border", "borders", "area", "size", "elevation", "height", "length", "depth", "bigger", "larger", "smaller",
  "taller", "longer", "shorter", "higher", "lower", "deeper", "shallower", "biggest", "largest", "smallest", "tallest",
  "longest", "highest", "deepest", "lowest", "point", "top", "peak", "summit", "total",
  ...Object.values(FACT_LEXICON).flat().filter((c) => !c.includes(" ")),
]);
/** Hedge and time words (criterion A list, plus the time phrase "these days" / "nowadays"). */
const R5_HEDGE = new Set(["roughly", "about", "approximately", "approx", "around", "exactly", "today", "now", "currently", "called", "please", "again", "anyway", "days", "nowadays"]);
/** Unit words (criterion A list, plus spelled-out forms). */
const R5_UNITS = new Set(["m", "km", "feet", "ft", "foot", "miles", "mile", "mi", "sqkm", "sq", "square", "km2", "km²", "meters", "metres", "meter", "metre", "kilometres", "kilometers", "kilometre", "kilometer"]);
/** Comparison connectors (criterion A list). */
const R5_COMPARE = new Set(["or", "than", "vs", "versus", "compared"]);
/** Multi-word property phrases ("capital city", "square kilometres"): a neighbour inside one counts as a property word. */
const R5_PHRASES = Object.values(FACT_LEXICON).flat().filter((c) => c.includes(" ")).map((c) => c.split(" "));
const r5Allowed = (w: string) => R5_QUESTION.has(w) || R5_PROPERTY.has(w) || R5_HEDGE.has(w) || R5_UNITS.has(w) || R5_COMPARE.has(w);
/** r3: a feature word glued to a name of that kind is the same place ("Mount Kilimanjaro", "Danube River"). */
const FEATURE: Record<string, string> = { mount: "mountain", mt: "mountain", mountain: "mountain", river: "river", lake: "lake" };

let index: Map<string, FactEntity[]> | null = null;
let lowerOk: Set<string> | null = null;
function entityIndex(): Map<string, FactEntity[]> {
  if (index) return index;
  index = new Map();
  const add = (key: string, e: FactEntity) => {
    const list = index!.get(key) ?? [];
    if (!list.includes(e)) list.push(e);
    index!.set(key, list);
  };
  for (const e of T.entities) {
    for (const name of [e.n, ...(e.a ?? []), ...(R3_ALIASES[e.q] ?? [])]) {
      const key = name.toLowerCase();
      // Short aliases ("US", "UK", "PRC") only as the question's own upper-case token (checked at lookup).
      if (key.length < 2) continue;
      add(key, e);
      // "U.S." is typed as the word "U.S" (titleCandidates drops a trailing dot).
      if (/\.$/.test(key)) add(key.replace(/\.+$/, ""), e);
    }
  }
  // r3 gate 1: one-word country and capital labels may be typed lowercase, unless the word is on the risk list.
  const capitals = new Set(T.entities.filter((e) => e.k === "country").flatMap((e) => (e.cap ?? []).map((c) => c.toLowerCase())));
  lowerOk = new Set(
    T.entities
      .filter((e) => !/\s/.test(e.n) && (e.k === "country" || (e.k === "city" && capitals.has(e.n.toLowerCase()))))
      .map((e) => e.n.toLowerCase())
      .concat(LOWER_ALIASES)
      .filter((n) => !LOWER_RISK.has(n)),
  );
  return index;
}

/** Words of a name that may stay lowercase when the name is typed ("Nobel Prize in Literature", "Lake of the Woods"). */
const NAME_STOP = new Set(["the", "of", "and", "de", "del", "da", "do", "dos", "das", "du", "des", "la", "le", "les", "el", "in", "on", "at", "y", "e", "a", "an", "to", "for", "by", "von", "van", "der", "den", "di", "al"]);
/** Every non-stopword of the name must be capitalised as typed (r2 gate 4: "white house", "the district" never resolve). */
const typedAsName = (cand: string) =>
  cand.split(/\s+/).every((w) => NAME_STOP.has(w.toLowerCase()) || /^[\p{Lu}\p{N}]/u.test(w) || /^\p{Ll}{1,2}['’]\p{Lu}/u.test(w));
/** Names shared with a well-known place that is not in the table (the US state Georgia): never answered (r2 gate 3). */
const HOMONYMS = new Set(["georgia"]);

interface Resolved { ents: FactEntity[]; ambiguous: boolean; starts: number[] }

/** Entities the question names, in question order, longest n-gram first; a word inside a found name never counts again. */
export function factEntities(query: string): FactEntity[] {
  return resolve(query).ents;
}

/** As factEntities, plus whether any name resolved to two or more entities (r2 gate 3: then the question is not answered). */
function resolve(query: string): Resolved {
  // r4 rule 2: each "the" typo is read as "the" only if, so read, a resolved name starts at the next word.
  const typos = [...query.matchAll(THE_TYPOS)];
  if (!typos.length) return resolveTyped(query);
  const tokenAt = (q: string, offset: number) => [...q.slice(0, offset).matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)].length;
  const accepted = typos.filter((m) => {
    const q2 = query.slice(0, m.index!) + "the" + query.slice(m.index! + m[0].length);
    return resolveTyped(q2).starts.includes(tokenAt(query, m.index!) + 1);
  });
  let q = query;
  for (const m of [...accepted].reverse()) q = q.slice(0, m.index!) + "the" + q.slice(m.index! + m[0].length);
  return resolveTyped(q);
}

function resolveTyped(query: string): Resolved {
  const idx = entityIndex();
  let ambiguous = false;
  const opening = (query.match(/[\p{L}\p{N}]+/u)?.[0] ?? "").toLowerCase();
  const used: string[] = [];
  const found: Array<{ e: FactEntity; at: number; tok: number }> = [];
  const spans: Array<{ e: FactEntity; words: string[] }> = [];
  const low = query.toLowerCase();
  // Word tokens with offsets, split exactly like titleCandidates (r3: neighbours of a name, a leading "the").
  const toks = [...query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)].map((m) => ({
    w: m[0].replace(/[.'’-]+$/, ""),
    s: m.index!,
    e: m.index! + m[0].length,
  }));
  const span = (words: string[]) => {
    for (let i = 0; i + words.length <= toks.length; i++)
      if (words.every((w, j) => toks[i + j].w.toLowerCase() === w)) return i;
    return -1;
  };
  const glued = (a: number, b: number) => /^\s+$/.test(query.slice(toks[a].e, toks[b].s));
  // r3 gate 2: "US" is a stopword ("us") for titleCandidates; typed upper-case it is the country.
  const cands = titleCandidates(query);
  if (toks.some((t) => t.w === "US")) cands.push("US");
  for (const cand of cands) {
    let lower = cand.toLowerCase();
    if (used.some((u) => has(u, lower))) continue;
    const single = !cand.includes(" ");
    const words = lower.split(/\s+/);
    const at = span(words);
    const prev = at > 0 && glued(at - 1, at) ? toks[at - 1] : null;
    // r3 gate 1: a one-word country/capital name may be typed lowercase ("what is the population of canada").
    const lowerName = single && !/^\p{Lu}/u.test(cand) && lowerOk!.has(lower);
    // r4 rule 1: a lowercase/mixed-case name of ≥ 2 words resolves when, case-folded, it names exactly one entity (with
    // an optional typed "the" before it) ("mont blanc", "mexico city").
    let safeList: FactEntity[] | undefined;
    // r5 rule C: the one-word risk list no longer blocks a multi-word name ("lake victoria", "new zealand"); the known
    // outside homonym (HOMONYMS) still does.
    if (!single && !typedAsName(cand) && !words.some((w) => HOMONYMS.has(w))) {
      const l = idx.get(lower) ?? (prev?.w.toLowerCase() === "the" ? idx.get(`the ${lower}`) : undefined);
      if (l?.length === 1) safeList = l;
    }
    // r3: otherwise a lowercase multi-word name ("south sudan", "mexico city") still needs capitals, and its inner word
    // must not answer for it ("sudan", "mexico"): the question is not answered.
    if (!safeList && !single && !typedAsName(cand) && idx.has(lower) && words.some((w) => lowerOk!.has(w))) {
      used.push(lower);
      ambiguous = true;
      continue;
    }
    // A lone word must be written as a name (capitalized), and never be the sentence's opening word.
    if (single && ((!/^\p{Lu}/u.test(cand) && !lowerName) || lower === opening)) continue;
    if (cand.length <= 3 && cand !== cand.toUpperCase() && !lowerName) continue;
    if (!lowerName && !safeList && !typedAsName(cand)) continue;
    let list = idx.get(lower);
    // r3 gate 2: "the UK", "the Amazon": an alias with a leading "the" matches when the question types the "the".
    if (!list && prev?.w.toLowerCase() === "the") list = idx.get((lower = `the ${lower}`));
    if (!list) continue;
    // r3: a lowercase one-word name after "south"/"new" is another place. (The r3 capitalised glue guard is replaced by
    // the r5 two-sided neighbour guard below, which runs once every name is resolved.)
    if (lowerName && prev && MODIFIERS.has(prev.w.toLowerCase())) {
      used.push(lower);
      ambiguous = true;
      continue;
    }
    // Same name, several entities: the exact label wins; two same-label entities (Bandung city/regency) → ambiguous.
    const exact = list.filter((e) => e.n.toLowerCase() === lower);
    const pool = exact.length ? exact : list;
    used.push(lower);
    if (pool.length > 1 || HOMONYMS.has(lower)) {
      ambiguous = true;
      continue;
    }
    const pick = pool[0];
    spans.push({ e: pick, words });
    if (!found.some((f) => f.e === pick)) found.push({ e: pick, at: low.indexOf(lower), tok: at });
  }
  if (!ambiguous && neighbourBlocked(toks, spans)) ambiguous = true;
  return { ents: found.sort((x, y) => x.at - y.at).map((f) => f.e), ambiguous, starts: found.map((f) => f.tok) };
}

/**
 * r5 rule A: true when some resolved name (every occurrence, any casing) has a disallowed neighbour on either side.
 * Before/after the span: a glued Mount/Mt/Mountain/River/Lake of the entity's kind extends the name (r3 exception); then
 * R5_SKIP words and numbers are skipped; the first other word must be allowed (r5Allowed, inside a multi-word lexicon
 * phrase, or a word of another resolved name), or there must be none.
 */
function neighbourBlocked(toks: Array<{ w: string }>, spans: Array<{ e: FactEntity; words: string[] }>): boolean {
  const lw = toks.map((t) => t.w.toLowerCase().replace(/’/g, "'"));
  const starts = (words: string[]) => lw.flatMap((_, i) => (words.every((w, j) => lw[i + j] === w) ? [i] : []));
  const owner = new Map<number, FactEntity>();
  for (const s of spans) for (const i of starts(s.words)) s.words.forEach((_, j) => owner.set(i + j, s.e));
  const inPhrase = (j: number) => R5_PHRASES.some((ph) => ph.some((_, k) => ph.every((w, m) => lw[j - k + m] === w)));
  const ok = (j: number, dir: 1 | -1, e: FactEntity) => {
    if (j >= 0 && j < lw.length && FEATURE[lw[j]] === e.k) j += dir;
    while (j >= 0 && j < lw.length && (R5_SKIP.has(lw[j]) || /^\p{N}/u.test(lw[j]))) j += dir;
    if (j < 0 || j >= lw.length) return true;
    const o = owner.get(j);
    if (o && o !== e) return true;
    return r5Allowed(lw[j]) || inPhrase(j);
  };
  return spans.some((s) => starts(s.words).some((i) => !ok(i - 1, -1, s.e) || !ok(i + s.words.length, 1, s.e)));
}

/** The templates whose wording the question uses. */
export function factTemplates(query: string): FactTemplate[] {
  let low = query.toLowerCase().replace(/[’']/g, "'");
  // r3 gate 4: the property word must stand alone ("area code" is not an area).
  for (const p of STOP_PHRASES) low = low.replace(new RegExp(`\\b${p}\\b`, "g"), " ");
  const found = (Object.keys(FACT_LEXICON) as FactTemplate[]).filter((t) => FACT_LEXICON[t].some((c) => has(low, c)));
  // r3 gate 3: "bigger than" / "which is larger" ask for area when nothing else is named.
  return found.length || !WEAK_AREA.some((c) => has(low, c)) ? found : ["area"];
}

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const year = (s?: string) => (s ? Number(s.slice(0, 4)) : null);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Years < 1000 print without a leading zero ("476", not "0476").
const date = (s: string) => (s.length >= 10 ? `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(0, 4))}` : `${Number(s.slice(0, 4))}`);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const millions = (n: number) => (n >= 1e9 ? `${fmt(n / 1e9, 2)} billion` : n >= 1e6 ? `${fmt(n / 1e6, 1)} million` : fmt(n));

/** The numeric value of a template for an entity, with its phrase; null when the table has none. */
function numeric(t: FactTemplate, e: FactEntity): { v: number; text: string; asOf: number | null } | null {
  switch (t) {
    case "population":
      // r3 gate 5: a figure dated before 2023 says so ("(dated 2021)").
      return e.pop
        ? { v: e.pop[0], text: `${millions(e.pop[0])}${e.pop[1] ? (e.pop[1] < 2023 ? ` (dated ${e.pop[1]})` : ` (${e.pop[1]})`) : ""}`, asOf: e.pop[1] }
        : null;
    case "area":
      return e.area ? { v: e.area, text: `${fmt(e.area)} km² (${fmt(e.area / 2.58999)} sq mi)`, asOf: null } : null;
    case "height": {
      const v = e.height ?? e.elev;
      return v ? { v, text: `${fmt(v)} m (${fmt(v * 3.28084)} ft)`, asOf: null } : null;
    }
    case "length":
      return e.len ? { v: e.len, text: `${fmt(e.len)} km (${fmt(e.len / 1.609344)} mi)`, asOf: null } : null;
    case "depth":
      return e.depth ? { v: e.depth, text: `${fmt(e.depth)} m`, asOf: null } : null;
    default:
      return null;
  }
}

const NOUN: Partial<Record<FactTemplate, string>> = { population: "population", area: "area", height: "height", length: "length", depth: "maximum depth" };
const MORE: Partial<Record<FactTemplate, string>> = { population: "has more people than", area: "is larger by area than", height: "is taller than", length: "is longer than", depth: "is deeper than" };
const LESS: Partial<Record<FactTemplate, string>> = { population: "has fewer people than", area: "is smaller by area than", height: "is lower than", length: "is shorter than", depth: "is shallower than" };

function source(asOf: number | null): string {
  // "From", not "Source:": the chat drops a trailing "Source:" list as model-invented (services/citations.ts).
  return `\n\nFrom Wikidata (CC0), offline table as of ${T.snapshot}${asOf ? `; figure dated ${asOf}` : ""}.`;
}

/** One entity, one template → the value line; null when the entity has no value for it. */
function single(t: FactTemplate, e: FactEntity, query: string): string | null {
  const name = e.n;
  const where = e.ctry?.length && !e.ctry.some((c) => e.d?.includes(c)) ? list(e.ctry) : "";
  const types = (e.t ?? []).filter((x) => !e.d?.includes(x));
  const inner = [[e.d, where].filter(Boolean).join(", "), types.length ? `type: ${types.join(", ")}` : ""].filter(Boolean).join("; ");
  const head = inner ? `${name} (${inner})` : name;
  const num = numeric(t, e);
  if (num) {
    const what = t === "height" && !e.height ? "elevation" : NOUN[t]!;
    return `${head}: ${what} ${num.text}.${source(num.asOf)}`;
  }
  switch (t) {
    case "capital":
      return e.cap?.length ? `The capital of ${name} is ${list(e.cap)}.${source(null)}` : null;
    case "currency":
      return e.cur?.length ? `${name}'s currency: ${list(e.cur)}.${source(null)}` : null;
    case "languages":
      return e.lang?.length ? `Official language${e.lang.length > 1 ? "s" : ""} of ${name}: ${list(e.lang)}.${source(null)}` : null;
    case "continent":
      return e.cont?.length ? `${name} is in ${list(e.cont)}.${source(null)}` : null;
    case "borders":
      return e.bord?.length ? `${name} borders ${list(e.bord)}.${source(null)}` : null;
    case "dates": {
      if (!e.inc) return null;
      const end = e.end ? `; it ended (came down / was dissolved) on ${date(e.end)}` : "";
      return `${head}: built/founded ${date(e.inc)}${end}.${source(null)}`;
    }
    case "electricity": {
      if (!e.plug?.length && !e.volt?.length) return null;
      const parts = [
        e.plug?.length ? `plug type${e.plug.length > 1 ? "s" : ""} ${list(e.plug)}` : "",
        e.volt?.length ? `mains voltage ${e.volt.map((v) => `${v} V`).join(" / ")}` : "",
        e.hz?.length ? `${e.hz.map((v) => `${v} Hz`).join(" / ")}` : "",
      ].filter(Boolean);
      return `${name}: ${parts.join(", ")}. Where two voltages are listed, it differs by region: check the socket or ask locally.${source(null)}`;
    }
    case "emergency": {
      if (!e.emerg?.length) return null;
      const nums = e.emerg.map(([n, use]) => (use ? `${use} ${n}` : n));
      return `Emergency numbers in ${name}: ${list(nums)}. In a life-threatening emergency, call now.${source(null)}`;
    }
    case "host":
      return e.loc?.length ? `${name}: held in ${list(e.loc)}.${source(null)}` : null;
    case "winner": {
      const y = query.match(/\b(1[89]\d\d|20\d\d)\b/)?.[1];
      const w = y ? e.win?.[y] : undefined;
      return w?.length ? `${name}, ${y}: ${list(w)}.${source(null)}` : null;
    }
    default:
      return null;
  }
}

/** Two entities and a numeric template → the computed verdict; null when either value is missing or they tie. */
function compare(t: FactTemplate, a: FactEntity, b: FactEntity, query: string): string | null {
  const x = numeric(t, a);
  const y = numeric(t, b);
  if (!x || !y || x.v === y.v) return null;
  const low = query.toLowerCase();
  const asOf = Math.max(x.asOf ?? 0, y.asOf ?? 0) || null;
  const verdict = `${x.v > y.v ? a.n : b.n} ${MORE[t]} ${x.v > y.v ? b.n : a.n}: ${a.n} ${x.text} vs ${b.n} ${y.text}.`;
  if (YES_NO.test(query.trim())) {
    const greater = GREATER.some((w) => has(low, w));
    const lesser = LESSER.some((w) => has(low, w));
    if (greater === lesser) return null;
    const yes = greater ? x.v > y.v : x.v < y.v;
    return `${yes ? "Yes" : "No"}. ${verdict}${source(asOf)}`;
  }
  return `${verdict}${source(asOf)}`;
}

/** Height of one entity against the depth of a lake: would it stick out of the water? */
function fit(tall: FactEntity, lake: FactEntity, query: string): string | null {
  const h = tall.height ?? tall.elev;
  const d = lake.depth;
  if (!h || !d) return null;
  const low = query.toLowerCase();
  const above = h > d;
  const gap = Math.abs(h - d);
  const asksOut = /\b(stick|poke|rise|be|show) (out|above)|\breach the surface|\babove the (water|surface)|\bbreak the surface/.test(low);
  const asksUnder = /\b(submerged|underwater|under water|covered|disappear)/.test(low);
  const lead = asksOut ? (above ? "Yes. " : "No. ") : asksUnder ? (above ? "No. " : "Yes. ") : "";
  return (
    `${lead}${tall.n} is ${fmt(h)} m ${tall.height ? "tall" : "high"}; ${lake.n} is ${fmt(d)} m deep at its deepest point, so its top would be ` +
    `${above ? `about ${fmt(gap)} m above the surface` : `about ${fmt(gap)} m below the surface (fully submerged)`}.${source(null)}`
  );
}

/** r6 fix 3: a place whose countries (P17) include exactly one table country, which is on exactly one continent. */
function placeContinent(e: FactEntity): string | null {
  if (e.k === "country" || !e.ctry?.length) return null;
  const c = T.entities.filter((x) => x.k === "country" && e.ctry!.includes(x.n));
  // A country on several continents (Egypt, France with its overseas regions) does not tell where the place is.
  if (c.length !== 1 || c[0].cont?.length !== 1) return null;
  return `${e.n} is in ${c[0].n}, which is in ${c[0].cont[0]}.${source(null)}`;
}

/**
 * r6 fix 5: "which is taller/higher, X or Y" / "is X taller/higher than Y" where each side, case-folded and with an
 * optional leading "the", is exactly one label/alias of exactly one entity, both of the same height class.
 */
function tallerFrame(q: string): FactAnswer | null {
  const idx = entityIndex();
  for (const re of R6_TALLER) {
    const m = q.match(re);
    if (!m) continue;
    const side = (s: string) => {
      const l = idx.get(s.toLowerCase().replace(/[’]/g, "'"));
      return l?.length === 1 ? l[0] : null;
    };
    const a = side(m[1]);
    const b = side(m[2]);
    if (!a || !b || a === b || !TALL_CLASS[a.k] || TALL_CLASS[a.k] !== TALL_CLASS[b.k]) return null;
    const text = compare("height", a, b, q);
    return text ? { kind: "facts", template: "height", entities: [a.q, b.q], text } : null;
  }
  return null;
}

export interface FactAnswer {
  kind: "facts";
  template: FactTemplate;
  entities: string[];
  text: string;
}

/** The FACTS instant answer, or null (the question takes the normal path). English questions only. */
export function factsAnswer(query: string): FactAnswer | null {
  let q = query.trim();
  // r6 fix 1: an opener typo is read as "what" / "how".
  for (const [re, w] of OPENER_TYPOS) q = q.replace(re, w);
  // r6 fix 4: "what country surrounds X" is read as "what country borders X".
  q = q.replace(R6_SURROUND, "$1 $2 border");
  // Desktop: a possessive after a capitalised name is read as the name ("Japan's population" → "Japan population").
  q = q.replace(/(?<=\p{Lu}\p{L}*)['’]s(?![\p{L}])/gu, "");
  if (!q || !(QUESTION.test(q) || QUESTION_OPENERS.test(q) || R6_OPENERS.test(q))) return null;
  const low = q.toLowerCase().replace(/[’']/g, "'");
  if (VETO.some((w) => has(low, w))) return null;
  const templates = factTemplates(q);
  if (templates.length !== 1) return null;
  const t = templates[0];
  if (t === "height") {
    const framed = tallerFrame(q);
    if (framed) return framed;
  }
  const { ents, ambiguous } = resolve(q);
  if (ambiguous || !ents.length || ents.length > 2) return null;
  const done = (text: string | null): FactAnswer | null => (text ? { kind: "facts", template: t, entities: ents.map((e) => e.q), text } : null);
  const comparing = COMPARE.some((w) => has(low, w));
  // r6 fix 3: "what continent is <place> in/on" → the continent of the place's one country.
  if (ents.length === 1 && t === "continent" && !ents[0].cont && R6_CONTINENT.test(q)) return done(placeContinent(ents[0]));
  if (ents.length === 1) return comparing ? null : done(single(t, ents[0], q));
  // Two entities: a comparison of one numeric value, or a height against a lake's depth.
  if (t === "depth") {
    const lake = ents.find((e) => e.depth);
    const tall = ents.find((e) => e !== lake && (e.height ?? e.elev));
    if (lake && tall && !tall.depth) return done(fit(tall, lake, q));
  }
  return comparing && NOUN[t] ? done(compare(t, ents[0], ents[1], q)) : null;
}
