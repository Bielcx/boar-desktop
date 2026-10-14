import type { RetrievedChunk } from "../rag/retrieve.types";
import type { SourceChunk } from "./events";
import {
  type AnswerErrorCode,
  type AnswerEvent,
  type AnswerOutcome as Outcome,
  type AnswerReceipt as Receipt,
  type AnswerStageName as Stage,
  type StageDetail,
} from "./events";

type PlacesEvent = Extract<AnswerEvent, { type: "places" }>;
export type PlacesResult = Omit<PlacesEvent, "type" | "answerId" | "tier">;
export type LocationStatus = Extract<AnswerEvent, { type: "location" }>["status"];

/** One model pass (fast or deep) inside an answer. */
export interface TierState {
  text: string;
  stage: Stage | null;
  detail?: StageDetail;
  outcome?: Outcome;
  receipt?: Receipt;
  error?: { code: AnswerErrorCode; message: string };
}

/** Everything the chat shows for one assistant message. */
export interface AnswerState {
  /** answer() calls whose events land here: the first answer, then a Deepen on the same message. */
  answerIds: string[];
  /** Global, deduplicated list: "[n]" in any tier's text is sources[n - 1]. */
  /** As the engine sent them, with relevance (0..1) when measured. */
  sources: SourceChunk[];
  /** sourceIndex is 0-based into sources ("[n]" = sourceIndex + 1, as the engine sends it). */
  instant?: { text: string; sourceIndex: number; confidence: number };
  /**
   * The engine's literal excerpt answer, streamed as instant-tier tokens (health/safety with an
   * on-topic source: lead, the source's steps with [n], emergency line). Prism NB-1: it was dropped.
   */
  extract?: string;
  fast?: TierState;
  deep?: TierState;
  /**
   * The instant tier finished: the source passage (receipt.modelId
   * "extractive") or the places list ("places") was the whole answer, no model ran.
   */
  instantDone?: { outcome: Outcome; receipt: Receipt; error?: { code: AnswerErrorCode; message: string } };
  /** A places answer: the list and how it was chosen, exactly as the engine sent it. */
  places?: PlacesResult;
  /** Device location lookup for a "near me" question. */
  location?: { status: LocationStatus; accuracyM?: number; ageS?: number };
  deepAvailable?: { estSeconds?: number; reason?: string };
  /** The model's weights stream from storage: answers will be slower than usual. */
  streamsFromStorage?: boolean;
  /** No offline source covers the question: the model answered from general knowledge (Tusk weak_sources). */
  weakSources?: boolean;
  /** …and the compact model declined to answer without a source (weak-sources state A); "Answer anyway" asks again. */
  weakDeclined?: boolean;
  /**
   * The [n] left in the final text of the finished tiers (Tusk done.cited, Prism CT-2), merged
   * across fast and deep. Undefined until a tier reports it: the card then shows every source.
   */
  cited?: number[];
  /** The engine classified the question as health/safety (done.safety): literal passage, emergency note. */
  safety?: boolean;
}

export function initialAnswer(answerId: string): AnswerState {
  return { answerIds: [answerId], sources: [] };
}

/** Routes a follow-up answer() (Deepen) into this message. */
export function attachAnswer(state: AnswerState, answerId: string): AnswerState {
  return state.answerIds.includes(answerId) ? state : { ...state, answerIds: [...state.answerIds, answerId] };
}

/** CT-2: read defensively, the field is new in the engine's done event. */
function withCited(state: AnswerState, cited: unknown): AnswerState {
  if (!Array.isArray(cited)) return state;
  const nums = cited.filter((n): n is number => typeof n === "number");
  return { ...state, cited: [...new Set([...(state.cited ?? []), ...nums])].sort((a, b) => a - b) };
}

function mergeSources(current: SourceChunk[], incoming: SourceChunk[]): SourceChunk[] {
  const seen = new Set(current.map((c) => c.chunkId));
  const added = incoming.filter((c) => !seen.has(c.chunkId) && seen.add(c.chunkId));
  return added.length > 0 ? [...current, ...added] : current;
}

function updateTier(state: AnswerState, tier: "fast" | "deep", patch: (t: TierState) => TierState): AnswerState {
  const current = state[tier] ?? { text: "", stage: null };
  return { ...state, [tier]: patch(current) };
}

/**
 * Folds engine events into the state of one answer. Events for another
 * answer (a stopped or replaced one still flushing) are ignored, and
 * nothing changes a tier after its "done".
 */
export function answerReducer(state: AnswerState, event: AnswerEvent): AnswerState {
  if (!state.answerIds.includes(event.answerId)) return state;

  switch (event.type) {
    case "sources":
      return { ...state, sources: mergeSources(state.sources, event.sources) };

    case "instant":
      return { ...state, instant: { ...event.snippet, confidence: event.confidence } };

    case "deep_available":
      return { ...state, deepAvailable: { estSeconds: event.estSeconds, reason: event.reason } };

    case "places": {
      const { type: _type, answerId: _id, tier: _tier, ...result } = event;
      return { ...state, places: result };
    }

    case "location":
      return { ...state, location: { status: event.status, accuracyM: event.accuracyM, ageS: event.ageS } };

    case "warning":
      if (event.code === "model_streams_from_storage") return { ...state, streamsFromStorage: true };
      if (event.code === "weak_sources") return { ...state, weakSources: true, weakDeclined: event.declined === true || undefined };
      return state;

    case "stage":
      if (event.tier === "instant" || state[event.tier]?.outcome) return state;
      return updateTier(state, event.tier, (t) => ({ ...t, stage: event.stage, detail: event.detail }));

    case "token":
      if (event.tier === "instant") return state.instantDone ? state : { ...state, extract: (state.extract ?? "") + event.text };
      if (state[event.tier]?.outcome) return state;
      return updateTier(state, event.tier, (t) => ({ ...t, stage: "generating", text: t.text + event.text }));

    case "done":
      if (event.safety) state = { ...state, safety: true };
      if (event.tier === "instant") {
        if (state.instantDone) return state;
        state = withCited(state, (event as { cited?: unknown }).cited);
        const finalText = (event as { finalText?: string }).finalText;
        if (state.extract != null && finalText != null) state = { ...state, extract: finalText };
        return { ...state, instantDone: { outcome: event.outcome, receipt: event.receipt, error: event.error } };
      }
      if (state[event.tier]?.outcome) return state;
      state = withCited(state, (event as { cited?: unknown }).cited);
      return updateTier(state, event.tier, (t) => ({
        ...t,
        // CT-1: the engine removed [n] the sources don't support; its final text replaces the streamed one.
        text: event.finalText ?? t.text,
        stage: null,
        outcome: event.outcome,
        receipt: event.receipt,
        error: event.error,
      }));
  }
}

/** What the answer is doing right now, for the stage indicator and announcements. */
export type AnswerPhase =
  | "searching"
  /** Waiting for the device's position for a "near me" question (up to ~10 s); a city can be typed meanwhile. */
  | "locating"
  | "loading_model"
  | "reading"
  | "generating"
  | "verifying"
  | "synthesizing"
  | "done"
  | "stopped"
  | "timeout"
  | "interrupted"
  | "error";

const STAGE_PHASE: Record<Stage, AnswerPhase> = {
  retrieving: "searching",
  loading_model: "loading_model",
  prefill: "reading",
  generating: "generating",
  verifying: "verifying",
  synthesizing: "synthesizing",
};

function tierPhase(t: TierState): AnswerPhase {
  if (t.outcome) return t.outcome === "success" ? "done" : t.outcome;
  return t.stage ? STAGE_PHASE[t.stage] : "searching";
}

/** The deep pass wins while it exists; otherwise the fast one; an extractive-only answer is done. */
/** The engine is waiting for a GPS fix (location status "locating", Boar GPS-1) and has not listed anything yet. */
export function isLocating(state: AnswerState): boolean {
  return state.location?.status === "locating" && !state.places;
}

export function answerPhase(state: AnswerState): AnswerPhase {
  if (isLocating(state)) return "locating";
  if (state.deep) return tierPhase(state.deep);
  if (state.fast) return tierPhase(state.fast);
  if (state.instantDone) return state.instantDone.outcome === "success" ? "done" : state.instantDone.outcome;
  return "searching";
}

export function isAnswerActive(state: AnswerState): boolean {
  const phase = answerPhase(state);
  return !["done", "stopped", "timeout", "interrupted", "error"].includes(phase);
}

/** Receipts of answers no model wrote: a source passage, a fixed engine answer, a places list. */
const MODEL_FREE_IDS = new Set(["extractive", "grounding-guard", "places", "calculator", "none"]);

/**
 * Why a model's answer rests on no source of this phone (Prism CT-5, Tusk a428bb6): the engine flags
 * both cases with weak_sources (and done.cited = []), so the sources tell them apart, since the engine
 * drops off-topic passages before sending them:
 * - "weak": nothing on the topic (no sources): "general knowledge" is true there;
 * - "uncited": passages on the topic were found but none is cited: the model may have used them.
 * A finished uncited model answer counts too without weak_sources (older engines).
 */
export function noSourceKind(state: AnswerState): "weak" | "uncited" | null {
  if (!state.weakSources && !uncitedModelAnswer(state)) return null;
  return state.sources.length > 0 ? "uncited" : "weak";
}

/** A finished model answer whose text cites none of the sources (engine's done.cited = []). */
export function uncitedModelAnswer(state: AnswerState): boolean {
  if (!state.cited || state.cited.length > 0) return false;
  const tier = state.deep ?? state.fast;
  return !!tier && tier.outcome === "success" && !!tier.text.trim() && !!tier.receipt && !MODEL_FREE_IDS.has(tier.receipt.modelId);
}

/** The Deepen button shows only after a successful fast pass, when the engine offered it. */
export function canDeepen(state: AnswerState): boolean {
  // Not on a declined answer (Tusk a740a0b: the compact model declines after streaming, finalText ""), nor an empty one.
  // Nor on the engine's fixed answer (grounding-guard, Tusk CT-4): the deep pass returns the same text.
  return (
    !!state.deepAvailable &&
    state.fast?.outcome === "success" &&
    !!state.fast.text &&
    state.fast.receipt?.modelId !== "grounding-guard" &&
    !state.weakDeclined &&
    !state.deep
  );
}

/**
 * The answer as saved when the chat screen went away mid-answer (FS-1: the navigation remounts on a
 * system font change): the stop we caused reads as "interrupted", which offers Try again, not as a
 * user's Stop.
 */
export function asInterrupted(state: AnswerState): AnswerState {
  const fix = (t?: TierState) => (t && (t.outcome === "stopped" || !t.outcome) ? { ...t, stage: null, outcome: "interrupted" as const } : t);
  return { ...state, fast: fix(state.fast), deep: fix(state.deep) };
}
