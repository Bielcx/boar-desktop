/**
 * Depth routing: decides HOW DEEP to answer, never WHICH model writes the
 * normal answer. Replaces the role-based router for ordinary chat
 * (router.ts kept for the evaluation harness).
 *
 * Why: the old router picked "the model for this task type" among installed
 * models. On a default install (one LLM) that was a no-op, and once a user
 * installed and picked a second model ("Use"), routing silently answered most
 * questions with the curated 1.5B instead (docs/ADAPTIVE_ROUTING.md, C1).
 *
 * Tiers:
 *   instant — best source sentence, no LLM (<1s). A preview, or the final
 *             answer to a confident lookup.
 *   fast    — the user's chosen model over compressed sources (~1.2k tokens).
 *   deep    — the "complete answer": the deep model (large MoE) in one pass
 *             over more sources when one is installed and fits; otherwise a
 *             multi-pass decompose → research → synthesize run on the fast
 *             model. Plus verification when a distinct verifier is installed.
 *
 * Pure and deterministic, like router.ts: same inputs, same plan.
 */
import { tooBigForAutoPick } from "./defaultModel";
import { isRetrievalIrrelevant } from "./classify";
import type { FitVerdict } from "../inference/memoryFit";
import type { AnswerTier } from "./events";
import type { ModelRole, TaskType } from "./types";

export interface DepthModel {
  id: string;
  label: string;
  sizeBytes: number;
  roles: ModelRole[];
  /** From estimateFit; undefined when unknown (treated as usable). */
  fit?: FitVerdict;
  /** Median decode speed measured on this device (telemetry); undefined = never measured. */
  tokPerSec?: number;
}

export interface DepthInput {
  taskType: TaskType;
  requestedTier: "auto" | "fast" | "deep";
  quickFirst: boolean;
  alwaysComplete: boolean;
  /** The model the user picked. Always writes the fast answer. */
  fastModel: DepthModel | null;
  /** Resolved with resolveDeepModel; null when none is installed/usable. */
  deepModel: DepthModel | null;
  /** Installed models that could verify (role "verifier"). */
  verifiers: DepthModel[];
  /** deepen(): sources already retrieved by the answer being deepened. */
  hasReusedSources: boolean;
}

export type InstantMode = "off" | "preview" | "may-finish";

export interface GenerationPlan {
  tier: Exclude<AnswerTier, "instant">;
  modelId: string;
  /** single = one generation; multipass = decompose → per-sub-question → synthesize (orchestrator.ts). */
  mode: "single" | "multipass";
  /** How many chunks to retrieve before compression. */
  retrieveK: number;
  /** Token budget for the compressed context. */
  contextTokens: number;
  /** Cap on the answer's length (the user's Max Output Tokens still applies when lower). */
  maxTokens?: number;
  /** Let a reasoning model think first (<think>). Off for the streaming MoE, where every token costs ~40 ms. */
  thinking: boolean;
}

export interface AnswerPlan {
  retrieve: boolean;
  instant: InstantMode;
  generation: GenerationPlan | null;
  verify: { modelId: string } | null;
  /** Emit deep_available after the fast answer. */
  offerDeep: boolean;
  reasonCodes: string[];
}

export const FAST_RETRIEVE_K = 6;
export const FAST_CONTEXT_TOKENS = 1200;

/**
 * The quick answer's budget, by what the question needs. Every context token is prefill before the
 * first word: on the X6 Pro (v1.1.0, Qwen2.5 1.5B) ~1.2k tokens of sources put it at 6-12 s, where
 * v1.0.0 with 1-2 sources was at 1.5-6 s, and in the 2026-09-24 benchmark the expected article
 * was always rank 1 or 2. A lookup needs one article's best sentences; a comparison or an
 * explanation two or three. Deep Research and "Always full answer" keep FAST_RETRIEVE_K and
 * FAST_CONTEXT_TOKENS per pass.
 */
export function quickBudget(taskType: TaskType): { retrieveK: number; contextTokens: number } {
  if (taskType === "lookup") return { retrieveK: 3, contextTokens: 450 };
  return { retrieveK: 4, contextTokens: 700 };
}
/**
 * Deep-model budget from the deep-tier contract (docs/adr/0001, measured on
 * Qwen3.6-35B-A3B with expert streaming: prefill 28-41 tok/s on an M4,
 * ~27 on a phone). TTFT <= 15 s and total <= 60 s need <= 400 context
 * tokens, <= 200 answer tokens and no thinking block.
 */
export const DEEP_RETRIEVE_K = 6;
export const DEEP_CONTEXT_TOKENS = 400;
export const DEEP_MAX_TOKENS = 200;

/**
 * Rule D6 (product roadmap v1.1): the automatic deep tier never picks a
 * model measured below 5 tok/s on this device (Qwen2.5-7B ran at ~2.7 and
 * timed out), and a model never measured is not eligible automatically.
 * A deep model the user picked explicitly is still used.
 */
export const DEEP_AUTO_MIN_TOK_PER_SEC = 5;
/** Measurements needed before a model's speed counts. */
export const MIN_SPEED_SAMPLES = 2;
/** Shorter generations are dominated by prefill and say little about decode speed. */
const MIN_TOKENS_FOR_SPEED = 16;

export interface SpeedSample {
  modelId?: string;
  tokPerSec?: number;
  tokensGenerated?: number;
  generationLatencyMs?: number;
  outcome?: string;
  createdAt?: number;
}

export interface ModelSpeed {
  medianTokPerSec: number;
  samples: number;
  /** createdAt (ms) of the newest sample. */
  lastAt?: number;
}

/**
 * Decode speed per model measured on this device, from execution telemetry
 * (listRecentExecutions). One source for both the router (rule D6) and the
 * model picker, so the UI shows exactly what routing uses. Only successful
 * generations of >= 16 tokens count; tok/s is the recorded value, else
 * tokensGenerated / generationLatencyMs.
 */
export function modelSpeedStats(records: SpeedSample[]): Map<string, ModelSpeed> {
  const by = new Map<string, { v: number[]; lastAt?: number }>();
  for (const r of records) {
    if (!r.modelId || (r.outcome && r.outcome !== "success")) continue;
    if ((r.tokensGenerated ?? 0) < MIN_TOKENS_FOR_SPEED) continue;
    const tps =
      r.tokPerSec && r.tokPerSec > 0
        ? r.tokPerSec
        : r.generationLatencyMs && r.generationLatencyMs > 0
          ? (r.tokensGenerated! / r.generationLatencyMs) * 1000
          : undefined;
    if (!tps || !Number.isFinite(tps)) continue;
    const e = by.get(r.modelId) ?? { v: [] };
    e.v.push(tps);
    if (r.createdAt && (!e.lastAt || r.createdAt > e.lastAt)) e.lastAt = r.createdAt;
    by.set(r.modelId, e);
  }
  const out = new Map<string, ModelSpeed>();
  for (const [id, { v, lastAt }] of by) {
    const s = [...v].sort((a, b) => a - b);
    const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    out.set(id, { medianTokPerSec: median, samples: s.length, lastAt });
  }
  return out;
}

/** Median tok/s per model with enough samples to count (what the router reads). */
export function measuredSpeeds(records: SpeedSample[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, sp] of modelSpeedStats(records)) if (sp.samples >= MIN_SPEED_SAMPLES) out.set(id, sp.medianTokPerSec);
  return out;
}

/** Rule D6 for a picker: eligible for the automatic deep tier? No measurement (or too few samples) = not eligible. */
export function deepAutoEligible(
  speed: ModelSpeed | null | undefined,
  /** CR-1: with the model and the device RAM, a model above AUTO_PICK_MAX_MODEL_BYTES is never automatic on a low-RAM phone. */
  device?: { model: { answerTier?: "default" | "compact"; sizeBytes?: number }; totalRamBytes: number }
): boolean {
  if (device && tooBigForAutoPick(device.model, device.totalRamBytes)) return false;
  return !!speed && speed.samples >= MIN_SPEED_SAMPLES && speed.medianTokPerSec >= DEEP_AUTO_MIN_TOK_PER_SEC;
}

/** Why a model is not eligible as the automatic deep model (null = eligible). */
export function deepAutoIneligibility(m: DepthModel): "unmeasured" | "too-slow" | null {
  if (m.tokPerSec === undefined) return "unmeasured";
  return m.tokPerSec < DEEP_AUTO_MIN_TOK_PER_SEC ? "too-slow" : null;
}

const usable = (m: DepthModel | null | undefined): m is DepthModel =>
  !!m && m.fit !== "insufficient" && m.fit !== "thrashing";

/**
 * The deep model: the user's explicit choice when installed, else the largest
 * installed LLM curated for "reasoning" measured at >= 5 tok/s here (rule
 * D6) — in both cases only if it differs from the fast model and fits (a
 * dense model that would re-read its weights from storage every token is not
 * a usable deep tier). null = explicitly none, or no eligible model.
 */
export function resolveDeepModel(
  installed: DepthModel[],
  fastModelId: string | undefined,
  explicitId: string | null | undefined
): DepthModel | null {
  if (explicitId === null) return null;
  const candidates = installed.filter((m) => m.id !== fastModelId && usable(m));
  if (explicitId) return candidates.find((m) => m.id === explicitId) ?? null;
  return (
    candidates
      .filter((m) => m.roles.includes("reasoning") && deepAutoIneligibility(m) === null)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ?? null
  );
}

export function planAnswer(i: DepthInput): AnswerPlan {
  const reasonCodes: string[] = [];
  const retrievalIrrelevant = isRetrievalIrrelevant(i.taskType);
  const retrieve = !retrievalIrrelevant && !i.hasReusedSources;
  reasonCodes.push(
    retrievalIrrelevant ? "retrieve:skipped-task-not-knowledge-based" : i.hasReusedSources ? "retrieve:reusing-sources" : "retrieve:yes"
  );

  const complete = i.requestedTier === "deep" || (i.requestedTier === "auto" && i.alwaysComplete);
  if (complete) reasonCodes.push(i.requestedTier === "deep" ? "depth:deep-requested" : "depth:always-complete");

  // Instant: only as the first layer of an automatic answer, and only when
  // there are sources to quote. It may stand as the whole answer only for a
  // lookup when the user did not ask for complete answers.
  let instant: InstantMode = "off";
  if (i.requestedTier === "auto" && i.quickFirst && !retrievalIrrelevant) {
    instant = !complete && i.taskType === "lookup" ? "may-finish" : "preview";
  }
  reasonCodes.push(`instant:${instant}`);

  let generation: GenerationPlan | null = null;
  if (complete && usable(i.deepModel)) {
    generation = {
      tier: "deep",
      modelId: i.deepModel.id,
      mode: "single",
      retrieveK: DEEP_RETRIEVE_K,
      contextTokens: DEEP_CONTEXT_TOKENS,
      maxTokens: DEEP_MAX_TOKENS,
      thinking: false,
    };
    reasonCodes.push(`generate:deep-model-${i.deepModel.id}`);
  } else if (complete && i.fastModel) {
    // No deep model: go deeper with the same model instead (several focused passes).
    generation = {
      tier: "deep",
      modelId: i.fastModel.id,
      mode: retrievalIrrelevant ? "single" : "multipass",
      retrieveK: FAST_RETRIEVE_K,
      contextTokens: FAST_CONTEXT_TOKENS,
      thinking: true,
    };
    reasonCodes.push(`generate:no-deep-model-${generation.mode}-on-${i.fastModel.id}`);
  } else if (i.fastModel) {
    generation = { tier: "fast", modelId: i.fastModel.id, mode: "single", ...quickBudget(i.taskType), thinking: true };
    reasonCodes.push(`generate:user-model-${i.fastModel.id}`);
  } else {
    reasonCodes.push("generate:no-model");
  }

  // Verification: part of the complete answer, with evidence to check
  // against, by a model other than the author (self-grading is not a check).
  let verify: AnswerPlan["verify"] = null;
  if (complete && generation && (retrieve || i.hasReusedSources)) {
    const v = i.verifiers.find((m) => m.id !== generation!.modelId && usable(m));
    if (v) {
      verify = { modelId: v.id };
      reasonCodes.push(`verify:${v.id}`);
    } else {
      reasonCodes.push("verify:skipped-no-distinct-verifier");
    }
  }

  const offerDeep =
    !complete && generation?.tier === "fast" && i.taskType !== "greeting" && !retrievalIrrelevant;
  if (offerDeep) reasonCodes.push(usable(i.deepModel) ? "offer-deep:deep-model" : "offer-deep:multipass");

  return { retrieve, instant, generation, verify, offerDeep, reasonCodes };
}
