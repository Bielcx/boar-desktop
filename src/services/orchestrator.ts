import { llamaEngine } from "../inference/LlamaEngine";
import { retrieve, RetrievedChunk, ConversationHistory } from "../rag/retrieve";
import { compressContext, mergeSources, onTopic } from "../routing/context";
import { taskRequest } from "../inference/format";

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
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 8);
  return lines.slice(0, 3).length > 0 ? lines.slice(0, 3) : [query];
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
  onTimeout: () => void,
  answerLanguage?: string
): Promise<string> {
  const perspectives = subResults
    .map((r, i) => `Perspective ${i + 1} (${r.subQuestion}):\n${r.answer}`)
    .join("\n\n");
  const system =
    `${instructionOf(systemPrompt)} You are synthesizing multiple research perspectives into one answer. ` +
    `Compare them, reconcile any conflicts, and write one unified, well-reasoned answer. ` +
    `Keep the source numbers exactly as the perspectives cite them, like [3]; do not renumber or invent sources.`;
  const language = answerLanguage?.trim() ? `\n\n(${answerLanguage.trim()})` : "";
  return generateStage(system, `Original question: ${originalQuery}\n\n${perspectives}${language}`, {
    nPredict: maxTokens,
    temperature: 0.6,
    onToken,
    timeoutMs: STAGE_TIMEOUT_MS,
    onTimeout,
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

  onProgress?.({ stage: "decomposing" });
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
    markTimedOut,
    options.answerLanguage
  );

  return { answer, subQuestions, citations: allChunks, fullCitations: full(), timedOut };
}
