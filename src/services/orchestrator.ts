import { llamaEngine } from "../inference/LlamaEngine";
import { retrieve, RetrievedChunk, ConversationHistory } from "../rag/retrieve";
import { compressContext, mergeSources, onTopic } from "../routing/context";
import { taskRequest } from "../inference/format";
import { followUpSearch } from "../routing/followUp";

/**
 * "Deep Research Mode" — a sequential multi-pass pipeline over the SAME
 * single loaded model, not literally multiple specialist models running
 * concurrently. Three frontier-agent-inspired ideas (running 3 models at
 * once, a planner model, a critic model) genuinely don't fit in the 12GB
 * RAM budget alongside everything else this app already loads — so this
 * decomposes the request into sequential llama.cpp calls on one context
 * instead: decompose -> research each sub-question (with its own
 * retrieval pass) -> synthesize. Slower than the normal single-pass chat
 * (several LLM calls instead of one), not "multiple AI agents." The UI
 * badge for this mode says "Deep Research (multi-pass)", not "multi-agent",
 * to avoid overclaiming what's actually happening.
 */

export type ResearchStage = "decomposing" | "researching" | "synthesizing";

export interface ResearchProgress {
  stage: ResearchStage;
  subQuestionIndex?: number;
  subQuestionCount?: number;
  /** "researching" only: the sub-question being researched, as the decomposition wrote it. */
  subQuestion?: string;
  /** "researching" only: its search is done and its sub-answer is being written. */
  answering?: boolean;
}

export interface ResearchResult {
  answer: string;
  subQuestions: string[];
  /**
   * Global, deduplicated source list: "[n]" anywhere in the answer refers to
   * citations[n - 1]. (Before, each sub-question numbered its own chunks
   * from [1] while the footer concatenated every list with duplicates, so
   * citations pointed at the wrong sources.)
   */
  citations: RetrievedChunk[];
  /**
   * `citations` as retrieved, before the sub-question's compression (same order, so fullCitations[n - 1] is
   * source [n] in full). The synthesis's [n] are checked against these (CT-1) and restored from them
   * (attribution), as single pass checks against the full retrieved chunk, not the compressed prompt text.
   */
  fullCitations?: RetrievedChunk[];
  /** True if any stage hit STAGE_TIMEOUT_MS and was cut off early. */
  timedOut?: boolean;
  /** Written from the previous answer alone ("summary", "continue"): its [n] are the previous answer's sources. */
  fromPreviousAnswer?: boolean;
  /** A recap of the conversation: no sources. */
  fromConversation?: boolean;
}

// Safety net, not a performance target — before this, no stage of this
// multi-call pipeline had any time ceiling at all (see
// docs/ADAPTIVE_ROUTING.md §14), so a single stuck stage on a slow/loaded
// device could hang the whole research pass indefinitely with no recovery
// but the user manually stopping it. 2 minutes is deliberately generous.
const STAGE_TIMEOUT_MS = 120_000;
/** Per-sub-question context budget: three of these plus the synthesis still prefill fast. */
const SUB_QUESTION_CONTEXT_TOKENS = 600;

export interface ResearchOptions {
  /** Chunks retrieved per sub-question (default 6, compressed to SUB_QUESTION_CONTEXT_TOKENS). */
  retrieveK?: number;
  /** Called once all sources are known (before synthesis), with the final numbered list. */
  onSources?: (sources: RetrievedChunk[]) => void;
  /**
   * The answer's language line (src/routing/context.ts PT_ANSWER_LANGUAGE for a Portuguese question), after the
   * synthesis input as the single-pass prompt puts it after the question. Only the synthesis gets it: the
   * sub-questions stay as the decomposition writes them (usually English, which matches the English sources).
   */
  answerLanguage?: string;
  /**
   * Called after each sub-question's retrieval and topic filter, before its generation, with the
   * numbered list so far, only when it grew. Each list extends the previous one (mergeSources keeps
   * first-seen order), so a source's number never changes; the last one equals what onSources gets.
   */
  onPartialSources?: (sources: RetrievedChunk[], progress: { subQuestionIndex: number; subQuestionCount: number }) => void;
  /** The last answer in full (history keeps only its opening): what a meta follow-up is written from. */
  previousAnswer?: string;
  /** Every earlier exchange, oldest first (history keeps only the last few): what a conversation recap is written from. */
  conversation?: Exchange[];
}

/** The earlier question and the answer to it, for a follow-up. */
export interface Exchange {
  question: string;
  answer: string;
}

/** Characters of the previous answer a follow-up's rewrite and synthesis see (its opening carries the topic). */
const PREVIOUS_ANSWER_CHARS = 800;
/** Characters of the previous answer a meta follow-up is written from (about 1,500 tokens: a 2,048-token answer fits). */
const FULL_PREVIOUS_ANSWER_CHARS = 6000;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** What a meta follow-up asks for (English and Portuguese): summarize, conclude, continue. */
const META_CORE = new Set(
  ("summary summarize summarise sum recap tldr conclusion conclude continue go more expand " +
    "resumo resuma resumir resume conclusão conclusao concluir conclua continua continuar prossiga mais").split(" ")
);
/** Words that may come with it ("a brief summary please", "go on", "tell me more", "um resumo por favor"). */
const META_FILLER = new Set(
  ("up on going keep a an the please pls brief short quick executive final give me can you could write make now it " +
    "this that of so and just tell in um uma o por favor faça faca dê de isso agora breve curto rápido executivo em").split(" ")
);

/**
 * A short message that only asks to summarize, conclude or continue the last answer ("TL;DR", "a brief summary
 * please", "continue", "resuma"). A question with a subject of its own ("summary of the causes of war") isn't one.
 */
export function isMetaFollowUp(query: string): boolean {
  const words = query.toLowerCase().replace(/tl;dr|tl dr/g, "tldr").split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  const content = words.filter((w) => !META_FILLER.has(w));
  return content.length > 0 && content.every((w) => META_CORE.has(w));
}

/** Words of a meta follow-up that ask for more rather than a summary ("continue", "tell me more", "prossiga"). */
const META_MORE = new Set(["continue", "go", "more", "expand", "continua", "continuar", "prossiga", "mais"]);

/**
 * A meta follow-up that only asks to summarize or conclude the last answer ("TL;DR", "a brief summary please"): plain
 * chat writes it from that answer. "continue" isn't one: written from the last answer with nothing new allowed, it
 * repeated that answer word for word (native app, X6, Oct 16).
 */
export function isSummaryFollowUp(query: string): boolean {
  return isMetaFollowUp(query) && !query.toLowerCase().split(/[^\p{L}]+/u).some((w) => META_MORE.has(w));
}

/** Exchanges a recap reads (the most recent ones) and characters of each answer: 12 × ~600 stays near 2,500 tokens. */
export const RECAP_EXCHANGES = 12;
const RECAP_ANSWER_CHARS = 600;

const RECAP_ASK = /\b(summar(y|ize|ise)|recap|tl;?dr|resum[aoeir]*|resumo)\b/i;
// This chat, not a conversation named in the question ("the conversation between Kennedy and Khrushchev").
const RECAP_OBJECT =
  /\b((our|this|my) (whole |entire )?(conversation|chat|discussion|session)|all (of )?(this|that)|(what )?we('ve| have)? (talked about|discussed|covered)|so far|(nossa|essa|esta) conversa|(o que )?(falamos|conversamos|discutimos))\b/i;

/** Citation numbers like [3]: a recap shows no sources, so the earlier answers' numbers would point at nothing. */
const CITATION = /\s*\[\d{1,4}\]/g;

/** A request to summarize this conversation ("Summarize our conversation in 3 bullet points", "resuma a nossa conversa"). */
export function isConversationRecap(query: string): boolean {
  return query.split(/\s+/).filter(Boolean).length <= 14 && RECAP_ASK.test(query) && RECAP_OBJECT.test(query);
}

/** Earlier recaps and summaries are left out: read back, the next recap copied them instead of the topics. */
const recapTopics = (conversation: Exchange[]) => conversation.filter((e) => !isConversationRecap(e.question) && !isSummaryFollowUp(e.question));

/**
 * A message about the conversation itself, answered from it without a search, even outside Deep Research:
 * "summarize our conversation", or "TL;DR" / "a summary please" after an answer. "Summarize our conversation" covered
 * only the last three exchanges (native app, X6, Oct 16). "continue" keeps the search: it asks for more than the chat
 * holds.
 */
export function aboutConversation(query: string, history: ConversationHistory | undefined, conversation: Exchange[]): boolean {
  return (isConversationRecap(query) && recapTopics(conversation).length > 0) || (isSummaryFollowUp(query) && lastAnswered(history) !== null);
}

/** A model declining instead of answering ("I'm sorry, but…", "Desculpe, não posso…"). */
const REFUSAL =
  /^(i'?m sorry|i am sorry|sorry|i (cannot|can't|can ?not|am unable|'m unable|don't have|do not have)|as an ai|unfortunately|desculp|lamento|infelizmente|não (posso|consigo|tenho)|nao (posso|consigo|tenho))/i;

const LIST_MARK = /^[-*\d.)\s]+/;

/**
 * The latest question in history that got an answer, and that answer (cut to PREVIOUS_ANSWER_CHARS). A stopped
 * answer leaves its question with no answer, and "continue" after a stopped "conclusion" researched "conclusion"
 * itself; the same words asked before count, so a second "continue" builds on the first one's answer.
 */
export function lastAnswered(history: ConversationHistory | undefined): Exchange | null {
  const turns = history?.turns ?? [];
  const answerAfter = (i: number): string => {
    for (let j = i + 1; j < turns.length && turns[j].role !== "user"; j++) {
      if (turns[j].role === "assistant") return turns[j].text.trim();
    }
    return "";
  };
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== "user" || !turns[i].text.trim()) continue;
    const answer = answerAfter(i);
    if (answer) return { question: turns[i].text.trim(), answer: cut(answer, PREVIOUS_ANSWER_CHARS) };
  }
  return null;
}

/**
 * The last exchange before the query when it reads as a follow-up (followUpSearch: it points back, or it is short
 * with no name of its own); null for a question that stands alone or a conversation's first.
 */
export function lastExchange(query: string, history: ConversationHistory | undefined): Exchange | null {
  const p = followUpSearch(query, history);
  return p.direct || p.fallback ? lastAnswered(history) : null;
}

/** The decomposition's lines as sub-questions (at most 3), refusals dropped; the question itself when none is usable. */
export function parseSubQuestions(text: string, query: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(LIST_MARK, "").trim())
    .filter((l) => l.length > 8 && !REFUSAL.test(l));
  return lines.length > 0 ? lines.slice(0, 3) : [query];
}

/**
 * One generation in the loaded model's own chat template when its GGUF ships
 * one (plain completion prompts make instruct models ramble), else plain.
 */
function generateStage(system: string, user: string, opts: Omit<Parameters<typeof llamaEngine.generate>[0], "prompt" | "messages">) {
  return llamaEngine.generate({ ...opts, ...taskRequest(system, user, "Answer:", llamaEngine.hasEmbeddedChatTemplate()) });
}

/** Context block numbered with GLOBAL source numbers. */
export function numberedContext(chunks: RetrievedChunk[], globalIndices: number[]): string {
  return chunks.map((c, i) => `[${globalIndices[i] + 1}] ${c.title}\n${c.body}`).join("\n\n");
}

async function decompose(query: string, onTimeout: () => void): Promise<string[]> {
  const prompt =
    `Break this research question into 2-3 focused sub-questions that ` +
    `together cover it well (e.g. technical analysis, counter-arguments, ` +
    `practical implications — whichever fit this question). One per line, ` +
    `no numbering, no extra commentary.\n\nQuestion: ${query}\n\nSub-questions:`;
  const text = await generateStage("You plan research.", prompt, {
    nPredict: 150,
    temperature: 0.4,
    timeoutMs: STAGE_TIMEOUT_MS,
    onTimeout,
  });
  return parseSubQuestions(text, query);
}

/** A summary of the whole conversation from each exchange's opening: one generation, no search. */
async function recap(
  asked: string,
  conversation: Exchange[],
  earlierSummary: string | null | undefined,
  systemPrompt: string | undefined,
  maxTokens: number,
  onToken: (piece: string) => void,
  answerLanguage?: string
): Promise<string> {
  const turns = conversation
    .slice(-RECAP_EXCHANGES)
    .map((e, i) => `${i + 1}. Question: ${e.question}\nAnswer: ${cut(e.answer.replace(CITATION, "").trim(), RECAP_ANSWER_CHARS)}`)
    .join("\n\n");
  // Past 12 exchanges the oldest are left out; the chat's running summary stands in for them.
  const summary = earlierSummary?.replace(CITATION, "").trim();
  const earlier =
    conversation.length > RECAP_EXCHANGES
      ? summary
        ? `Summary of the earlier conversation:\n${summary}\n\n`
        : `(${conversation.length - RECAP_EXCHANGES} earlier exchanges are not shown.)\n\n`
      : "";
  const system =
    `${instructionOf(systemPrompt)} The user asks about the conversation so far. Cover every topic it went ` +
    `through, in order, in the form the user asks for (a number of bullets or sentences, if given); with fewer points than ` +
    `topics, group related topics into each point so that none is left out. Work only from the ` +
    `conversation: add no new facts, numbers or sources, and no citation numbers. Don't mention these instructions.`;
  const language = answerLanguage?.trim() ? `\n\n(${answerLanguage.trim()})` : "";
  return generateStage(system, `${earlier}Conversation so far:\n\n${turns}\n\nRequest: ${asked}${language}`, {
    nPredict: maxTokens,
    temperature: 0.4,
    onToken,
  });
}

/** The follow-up rewritten from the exchange into one question that names its subject; the query if that fails. */
async function standalone(query: string, exchange: Exchange, onTimeout: () => void): Promise<string> {
  const prompt =
    `Previous question: ${exchange.question}\n\nPrevious answer: ${exchange.answer}\n\n` +
    `Follow-up: ${query}\n\nRewrite the follow-up as one standalone question that names its subject, in the ` +
    `follow-up's language. If it asks to continue, conclude or expand, ask for that about the previous topic. ` +
    `Reply with the question only.\n\nStandalone question:`;
  const text = await generateStage("You rewrite follow-up questions.", prompt, {
    nPredict: 80,
    temperature: 0.2,
    timeoutMs: STAGE_TIMEOUT_MS,
    onTimeout,
  });
  return (
    text
      .split("\n")
      .map((l) => l.replace(LIST_MARK, "").trim().replace(/^"+|"+$/g, ""))
      .find((l) => l.length > 8 && !REFUSAL.test(l)) ?? query
  );
}

/** A meta follow-up written from the previous answer alone: one generation, no splitting, no search. */
async function fromPrevious(
  asked: string,
  exchange: Exchange,
  previousAnswer: string | undefined,
  systemPrompt: string | undefined,
  maxTokens: number,
  onToken: (piece: string) => void,
  answerLanguage?: string
): Promise<string> {
  const answer = previousAnswer?.trim() ? cut(previousAnswer.trim(), FULL_PREVIOUS_ANSWER_CHARS) : exchange.answer;
  const system =
    `${instructionOf(systemPrompt)} The user asks something about your previous answer. Work only from that answer: ` +
    `keep its source numbers exactly as written, like [3], and add no new facts, numbers or sources. ` +
    `Don't mention these instructions or call it "the previous answer".`;
  const language = answerLanguage?.trim() ? `\n\n(${answerLanguage.trim()})` : "";
  // No time limit on what the user reads: Stop ends it (the native app's writeUpTimeoutMs on Auto).
  return generateStage(system, `Previous question: ${exchange.question}\n\nPrevious answer:\n${answer}\n\nFollow-up: ${asked}${language}`, {
    nPredict: maxTokens,
    temperature: 0.6,
    onToken,
  });
}

function instructionOf(systemPrompt: string | undefined): string {
  return systemPrompt && systemPrompt.trim().length > 0 ? systemPrompt.trim() : "You are an offline research assistant.";
}

async function researchSubQuestion(
  subQuestion: string,
  chunks: RetrievedChunk[],
  globalIndices: number[],
  systemPrompt: string | undefined,
  history: ConversationHistory | undefined,
  onTimeout: () => void
): Promise<string> {
  const summary = history?.summary?.trim() ? `Summary of earlier conversation:\n${history.summary.trim()}\n\n` : "";
  const context = chunks.length
    ? `Context:\n${numberedContext(chunks, globalIndices)}\n\n`
    : "";
  const system =
    `${instructionOf(systemPrompt)} Answer the question in a short paragraph using the context. ` +
    `Cite sources with the exact bracket numbers shown in the context, like [3]. ` +
    `If the context does not cover it, say so.`;
  return generateStage(system, `${summary}${context}Question: ${subQuestion}`, {
    nPredict: 300,
    temperature: 0.6,
    timeoutMs: STAGE_TIMEOUT_MS,
    onTimeout,
  });
}

async function synthesize(
  originalQuery: string,
  subResults: { subQuestion: string; answer: string }[],
  systemPrompt: string | undefined,
  maxTokens: number,
  onToken: (piece: string) => void,
  answerLanguage?: string,
  followUp?: { exchange: Exchange; asked: string }
): Promise<string> {
  const perspectives = subResults
    .map((r, i) => `Perspective ${i + 1} (${r.subQuestion}):\n${r.answer}`)
    .join("\n\n");
  const system =
    `${instructionOf(systemPrompt)} You are synthesizing multiple research perspectives into one answer. ` +
    `Compare them, reconcile any conflicts, and write one unified, well-reasoned answer. ` +
    `Keep the source numbers exactly as the perspectives cite them, like [3]; do not renumber or invent sources.` +
    // A Detailed write-up ended with "Synthesis of Perspectives: Perspective 1… 2… 3…" (native app, X6, Oct 14).
    ` Do this silently: the reader never sees the perspectives, so never mention them, the sub-questions or the research steps, and add no section about them.`;
  const language = answerLanguage?.trim() ? `\n\n(${answerLanguage.trim()})` : "";
  const earlier = followUp
    ? `Previous question: ${followUp.exchange.question}\n\nPrevious answer: ${followUp.exchange.answer}\n\nFollow-up as asked: ${followUp.asked}\n\n`
    : "";
  // No time limit on what the user reads: Stop ends it (the native app's writeUpTimeoutMs on Auto).
  return generateStage(system, `${earlier}Original question: ${originalQuery}\n\n${perspectives}${language}`, {
    nPredict: maxTokens,
    temperature: 0.6,
    onToken,
  });
}

export async function runDeepResearch(
  query: string,
  systemPrompt: string | undefined,
  history: ConversationHistory | undefined,
  maxTokens: number,
  onProgress?: (p: ResearchProgress) => void,
  onToken?: (piece: string) => void,
  shouldStop?: () => boolean,
  options: ResearchOptions = {}
): Promise<ResearchResult> {
  let timedOut = false;
  const markTimedOut = () => {
    timedOut = true;
  };

  // "Summarize our conversation in 3 bullet points" covered only the last two topics of nine (native app, X6, Oct 16).
  const topics = recapTopics(options.conversation ?? []);
  if (topics.length > 0 && isConversationRecap(query)) {
    onProgress?.({ stage: "synthesizing" });
    const answer = await recap(query, topics, history?.summary, systemPrompt, maxTokens, onToken ?? (() => {}), options.answerLanguage);
    return { answer, subQuestions: [], citations: [], fullCitations: [], timedOut, fromConversation: true };
  }
  onProgress?.({ stage: "decomposing" });
  const asked = query;
  // A follow-up ("conclusion", "continue", "and its side effects?") is split, searched and judged as a standalone
  // question; split as written it searched for "conclusion" and refused (native app, X6, Oct 13).
  const meta = isMetaFollowUp(asked);
  // A meta follow-up refers to the last answer whatever its wording ("TL;DR" reads as a name to followUpSearch).
  const exchange = meta ? lastAnswered(history) : lastExchange(asked, history);
  // "summary", "conclusion", "TL;DR", "continue": the answer is already on screen, so write from it instead of
  // researching again (~5 min of splitting and searching for a summary on the X6).
  if (exchange && meta) {
    onProgress?.({ stage: "synthesizing" });
    const answer = await fromPrevious(asked, exchange, options.previousAnswer, systemPrompt, maxTokens, onToken ?? (() => {}), options.answerLanguage);
    return { answer, subQuestions: [], citations: [], fullCitations: [], timedOut, fromPreviousAnswer: true };
  }
  if (exchange) query = await standalone(asked, exchange, markTimedOut);
  // Stop cancels only the generation running at that moment: the next stage would start a new one.
  if (shouldStop?.()) return { answer: "", subQuestions: [], citations: [], fullCitations: [], timedOut };
  const subQuestions = await decompose(query, markTimedOut);

  const subResults: { subQuestion: string; answer: string }[] = [];
  const perQuestion: RetrievedChunk[][] = [];
  let allChunks: RetrievedChunk[] = [];
  // Each source as retrieved, before compressContext trimmed it to the sub-question's budget.
  const fullById = new Map<string, RetrievedChunk>();
  const full = () => allChunks.map((c) => fullById.get(c.chunkId) ?? c);
  for (let i = 0; i < subQuestions.length; i++) {
    // llamaEngine.stop() only interrupts whichever single completion call is
    // in flight *right now* — with several sequential completions here
    // (decompose, each sub-question, synthesize), a stop request needs its
    // own check between stages or the pipeline just carries on to the next
    // one regardless of the user having asked it to stop.
    if (shouldStop?.()) return { answer: "", subQuestions, citations: allChunks, fullCitations: full(), timedOut };
    onProgress?.({ stage: "researching", subQuestionIndex: i, subQuestionCount: subQuestions.length, subQuestion: subQuestions[i] });
    const retrieved = await retrieve(subQuestions[i], options.retrieveK ?? 6);
    for (const c of retrieved) if (!fullById.has(c.chunkId)) fullById.set(c.chunkId, c);
    const compressed = compressContext(subQuestions[i], retrieved, { tokenBudget: SUB_QUESTION_CONTEXT_TOKENS }).chunks;
    // CT-2 / RT-1 here too: a source off the topic of this sub-question (or of the whole
    // question, which the decomposition rephrases) is not read, numbered or shown.
    // Portuguese too (Quill, 014c054: every source the chat is shown is on topic); the decomposition
    // usually rephrases a PT question's sub-questions in English, which match the English sources.
    const chunks = compressed.filter((c) => onTopic(subQuestions[i], c) || onTopic(query, c));
    perQuestion.push(chunks);
    // Number against every source seen so far, so the same chunk keeps one number across sub-questions.
    const merged = mergeSources(perQuestion);
    const grew = merged.sources.length > allChunks.length;
    allChunks = merged.sources;
    // The chat can show this sub-question's sources now, not after every sub-answer is written.
    if (grew) options.onPartialSources?.(allChunks, { subQuestionIndex: i, subQuestionCount: subQuestions.length });
    onProgress?.({ stage: "researching", subQuestionIndex: i, subQuestionCount: subQuestions.length, subQuestion: subQuestions[i], answering: true });
    const answer = await researchSubQuestion(subQuestions[i], chunks, merged.indexMaps[i], systemPrompt, history, markTimedOut);
    subResults.push({ subQuestion: subQuestions[i], answer });
  }
  options.onSources?.(allChunks);

  if (shouldStop?.()) return { answer: "", subQuestions, citations: allChunks, fullCitations: full(), timedOut };

  onProgress?.({ stage: "synthesizing" });
  // The final synthesized answer respects the user's Max Output Tokens
  // setting, same as a normal single-pass reply — the sub-question research
  // passes above use their own smaller fixed budgets since they're
  // intermediate working material, not what the user reads.
  const answer = await synthesize(
    query,
    subResults,
    systemPrompt,
    maxTokens,
    onToken ?? (() => {}),
    options.answerLanguage,
    exchange ? { exchange, asked } : undefined
  );

  return { answer, subQuestions, citations: allChunks, fullCitations: full(), timedOut };
}
