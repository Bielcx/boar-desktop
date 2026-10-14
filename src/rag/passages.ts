/**
 * Sentence-level retrieval for context compression: the question's passages,
 * each cut down to its best sentences, with scores and sources. The prompt
 * builder (src/services, owned by the engine) allocates the final token budget.
 */
import { buildLexicalQuery } from "./pure";
import { applyCharBudget, leadParagraph, selectSentences, type WeightedTerm } from "./passages.pure";
import type { Passage, PassageOptions, PassageRetrieval } from "./passages.types";
import { articleUrl, searchWikiPacks } from "./packs";
import { retrieve } from "./retrieve";
import { embeddingEngine } from "./embed";
import { ACTION_INTENT, LONG_TAIL_VIEWS, prefixOf, sectionKind, type Stem } from "./wikiPack";

export type { Passage, PassageOptions, PassageRetrieval } from "./passages.types";

const stemTerms = (stems: Stem[]): WeightedTerm[] => stems.map((s) => ({ prefixes: [prefixOf(s.stem)], weight: s.idf }));

/** The built-in corpus has no idf table: every content word weighs the same. */
function lexicalTerms(query: string): WeightedTerm[] {
  return buildLexicalQuery(query)?.terms.map((t) => ({ prefixes: t.forms, weight: 1 })) ?? [];
}

// A passage from an article the question names is relevant even where its sentences don't repeat the question's words.
const NAMED_BONUS = 0.2;
// A what-to-do question: the passages are re-ranked by their sentences, so the section's purpose must count here
// too, or a symptoms sentence that repeats the question's words beats the Treatment section (gate 5e70bbd).
const ACTION_BONUS = 0.3;
const BACKGROUND_PENALTY = 0.3;

export async function retrievePassages(query: string, opts: PassageOptions = {}): Promise<PassageRetrieval> {
  const { k = 6, charBudget = 4800, maxSentencesPerPassage = 3, titles, expand } = opts;
  const t0 = Date.now();
  const queryVec = await embeddingEngine.embed(query).catch(() => undefined);
  const [wiki, base] = await Promise.all([
    searchWikiPacks(query, { k, titles, expand, queryVec }).catch(() => []),
    retrieve(query, k, { queryVec, includeWikiPacks: false }).catch(() => []),
  ]);
  const t1 = Date.now();

  const passages: Passage[] = [];
  const actionQuestion = ACTION_INTENT.test(query);
  const purpose = (h: { action: boolean; lead: boolean; section: string }) =>
    !actionQuestion ? 0 : h.action ? ACTION_BONUS : !h.lead && sectionKind(h.section) === "background" ? -BACKGROUND_PENALTY : 0;
  for (const w of wiki) {
    const terms = stemTerms(w.stems);
    for (const h of w.hits) {
      const sentences = selectSentences(h.text, terms, maxSentencesPerPassage, h.lead);
      if (!sentences.length) continue;
      const best = Math.max(...sentences.map((s) => s.score));
      passages.push({
        id: `pack:${w.packId}:${h.chunkId}`,
        text: sentences.map((s) => s.text).join(" "),
        sentences,
        score: Math.max(0, Math.min(1, best + (h.via === "title" ? NAMED_BONUS : 0) + purpose(h))),
        source: {
          title: h.title,
          section: h.section,
          url: articleUrl(h.title, h.source, h.url),
          kind: h.source,
          ...(h.license ? { license: h.license } : {}),
        },
        views: h.views,
        via: h.via,
        action: h.action,
      });
    }
  }
  // Built-in corpus, user documents and format-1 packs.
  const baseTerms = lexicalTerms(query);
  for (const c of base) {
    if (passages.some((p) => p.id === c.chunkId)) continue;
    const sentences = selectSentences(c.body, baseTerms, maxSentencesPerPassage, false);
    if (!sentences.length) continue;
    const url = c.source?.match(/https?:\/\/\S+/)?.[0] ?? "";
    passages.push({
      id: c.chunkId,
      text: sentences.map((s) => s.text).join(" "),
      sentences,
      score: Math.max(...sentences.map((s) => s.score)),
      source: { title: c.title, section: "", url, kind: c.chunkId.startsWith("pack:") || url ? "builtin" : "user" },
      views: 0,
      via: c.matchType === "semantic" ? "semantic" : "bm25",
    });
  }
  passages.sort((a, b) => b.score - a.score);
  const kept = applyCharBudget(passages.slice(0, k), charBudget);

  // The instant answer's lead: the top passage's article, first paragraph whole.
  const top = kept[0];
  const topWiki = top && wiki.find((w) => top.id.startsWith(`pack:${w.packId}:`));
  if (top && topWiki) {
    const hit = topWiki.hits.find((h) => `pack:${topWiki.packId}:${h.chunkId}` === top.id)!;
    top.lead = leadParagraph((await topWiki.pack.article(hit.articleId)).text);
  }
  const main = wiki.flatMap((w) => w.hits).find((h) => h.via === "title") ?? wiki.flatMap((w) => w.hits)[0];
  return {
    passages: kept,
    longTail: !!main && main.views > 0 && main.views < LONG_TAIL_VIEWS,
    timingsMs: { search: t1 - t0, sentences: Date.now() - t1 },
  };
}
