/**
 * Sentence-level retrieval results (src/rag/passages.ts), in a file without
 * native imports so pure code and tests can use the types.
 */

export type PassageSourceKind = "enwiki" | "enwikivoyage" | "enwikibooks" | "appropedia" | "usgov" | "eips" | "ethspecs" | "ethereumorg" | "bips" | "builtin" | "user";

export interface PassageSentence {
  text: string;
  /**
   * 0..1, comparable across passages and questions: the share of the
   * question's term weight (idf) that the sentence contains.
   */
  score: number;
}

export interface Passage {
  /** Stable id, e.g. "pack:boar-wiki-en:123456" or a built-in chunk id; use it to dedupe citations. */
  id: string;
  /** The chosen sentences in document order, joined by spaces. */
  text: string;
  sentences: PassageSentence[];
  /** 0..1 relevance of the passage (its best sentence, plus a bonus for an article the question names). */
  score: number;
  /** `license` is set when the pack records it per page (show it with the link: CC BY-SA requires attribution). */
  source: { title: string; section: string; url: string; kind: PassageSourceKind; license?: string };
  /** Monthly pageviews of the article, 0 when unknown. */
  views: number;
  via: "title" | "bm25" | "semantic";
  /** The passage's section tells what to do (Treatment, First aid, During…); absent for sources without sections. */
  action?: boolean;
  /**
   * Only on the top passage when it comes from an article: the article's
   * first paragraph, whole sentences, for an instant "what is X" answer.
   */
  lead?: string;
}

export interface PassageRetrieval {
  passages: Passage[];
  /** The main topic is little-read (under LONG_TAIL_VIEWS a month): prefer answering from the sources. */
  longTail: boolean;
  timingsMs: { search: number; sentences: number };
}

export interface PassageOptions {
  /** Passages to return, default 6. */
  k?: number;
  /** Cap on the total characters of returned sentences, default 4800 (~1.2k tokens). */
  charBudget?: number;
  /** Default 3. */
  maxSentencesPerPassage?: number;
  /** Article titles proposed by a planner; resolved through redirects. */
  titles?: string[];
  /** Called only when the keyword search finds fewer than 2 passages. */
  expand?: (query: string) => Promise<string[]>;
}
