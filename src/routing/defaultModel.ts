/**
 * Which answer model a device gets when the user has not picked one (v1.1:
 * Qwen3-4B-Instruct-2507 is the default, Qwen2.5-1.5B the "Compact" option).
 *
 * The 4B is dense: every token reads all 2.5 GB of weights, so it is only a
 * good default when it can stay resident. Rule: the catalog's "default" tier
 * model if the device has more than 4.5 GB of RAM, its memory fit is
 * "resident" or "streaming" and it was not measured under 6 tok/s; otherwise
 * the "compact" one. 4 GB phones (iPhone 13) always get the compact model.
 * Other installed models (LFM2.5, Hugging Face picks) only win when neither
 * tier can: the largest one measured at 6 tok/s or more.
 *
 * Pure: the setup wizard, the boot route, the model list and the answer
 * pipeline call it with the installed (or offered) models and the device
 * RAM / fit / measured speed readouts.
 */
import type { FitVerdict } from "../inference/memoryFit";

export const COMPACT_ONLY_MAX_RAM_BYTES = 4.5 * 1024 ** 3;
/**
 * On a phone with at most COMPACT_ONLY_MAX_RAM_BYTES, nothing bigger than the
 * compact model is used unless the user confirmed it (Piston, CR-1: the 4B on
 * 3.8 GB was OOM-killed): not as the saved pick, the default or deep. The
 * compact 1.5B is ~1.0 GB; this leaves margin for its peers.
 */
export const LOW_RAM_MAX_MODEL_BYTES = 1.6e9;

/**
 * Lower cap for the automatic pick only (rankAnswerModels, the automatic deep
 * tier). Measured on an iPhone 13 (4 GB, 2026-09-30): ~1.5 GB models
 * (MiniCPM5-2B, LFM2.5-2.6B Q4_0) load but thrash mmap and decode at
 * ~0.35 tok/s, so the app never picks them by itself. A model of this size the
 * user already chose stays in use (LOW_RAM_MAX_MODEL_BYTES decides that).
 */
export const AUTO_PICK_MAX_MODEL_BYTES = 1.1e9;

function aboveLowRamCap(m: { answerTier?: "default" | "compact"; sizeBytes?: number }, totalRamBytes: number, cap: number): boolean {
  const lowRam = totalRamBytes > 0 && totalRamBytes <= COMPACT_ONLY_MAX_RAM_BYTES;
  if (!lowRam || m.answerTier === "compact") return false;
  return m.answerTier === "default" || (m.sizeBytes ?? Number.POSITIVE_INFINITY) > cap;
}

/** True when a model may not be used on this device, even as the saved pick, until the user confirms it. */
export function tooBigForLowRam(m: { answerTier?: "default" | "compact"; sizeBytes?: number }, totalRamBytes: number): boolean {
  return aboveLowRamCap(m, totalRamBytes, LOW_RAM_MAX_MODEL_BYTES);
}

/** True when the app may not pick a model by itself on this device (the user can still choose it). */
export function tooBigForAutoPick(m: { answerTier?: "default" | "compact"; sizeBytes?: number }, totalRamBytes: number): boolean {
  return aboveLowRamCap(m, totalRamBytes, AUTO_PICK_MAX_MODEL_BYTES);
}

/** The compact tier, or an untiered model no bigger than it: too small to answer from memory unasked. */
export function isCompactModel(m: { answerTier?: "default" | "compact"; sizeBytes?: number }): boolean {
  if (m.answerTier) return m.answerTier === "compact";
  return (m.sizeBytes ?? Number.POSITIVE_INFINITY) <= LOW_RAM_MAX_MODEL_BYTES;
}

/** Measured median decode speed under which a model is too slow to be the automatic default. */
export const DEFAULT_MIN_TOK_PER_SEC = 6;

export interface AnswerModelCandidate {
  id: string;
  /** Catalog tier: "default" (Qwen3-4B) or "compact" (Qwen2.5-1.5B); absent for any other model. */
  answerTier?: "default" | "compact";
  /** Memory fit on this device (estimateFit / estimateMemoryFit); undefined = unknown. */
  fit?: FitVerdict;
  /** File size, for "largest fast" and "smallest" choices; undefined = unknown. */
  sizeBytes?: number;
  /**
   * Median measured tok/s on this device, only when there are enough samples
   * (measuredSpeeds / modelSpeedStats with MIN_SPEED_SAMPLES); undefined = not measured.
   */
  tokPerSec?: number;
}

/** Why the picked model was picked. Stable codes: the UI translates them. */
export type PickReason =
  | "default-tier"
  | "compact-low-ram"
  | "compact-does-not-fit"
  | "compact-default-too-slow"
  | "largest-fast"
  | "smallest-fallback";

/** Why another model was not picked. */
export type NotPickedReason = "low-ram" | "wont-fit" | "too-slow" | "unmeasured" | "outranked";

export interface DefaultModelChoice {
  id: string;
  reason: PickReason;
}

export interface RankedAnswerModel {
  id: string;
  picked: boolean;
  reason: PickReason | NotPickedReason;
}

export interface AnswerModelRanking {
  pick: DefaultModelChoice | null;
  /** Every candidate once, the pick first, then the rest in order of preference. */
  ranked: RankedAnswerModel[];
}

const fits = (c: AnswerModelCandidate) => c.fit !== "thrashing" && c.fit !== "insufficient";
const tooSlow = (c: AnswerModelCandidate) => c.tokPerSec !== undefined && c.tokPerSec < DEFAULT_MIN_TOK_PER_SEC;
const size = (c: AnswerModelCandidate) => c.sizeBytes ?? Number.POSITIVE_INFINITY;

/**
 * The automatic answer model among the installed ones, and why each other
 * one was not chosen. In order: the default tier (Qwen3-4B) when the phone
 * has more than 4.5 GB, it fits and it is not measured under 6 tok/s; else
 * the compact tier when it fits and is not too slow; else the largest model
 * that fits and was measured at 6 tok/s or more; else the smallest, fitting
 * ones first. An unmeasured speed never disqualifies a tier model.
 */
export function rankAnswerModels(candidates: AnswerModelCandidate[], totalRamBytes: number): AnswerModelRanking {
  if (!candidates.length) return { pick: null, ranked: [] };
  const lowRam = totalRamBytes > 0 && totalRamBytes <= COMPACT_ONLY_MAX_RAM_BYTES;
  const def = candidates.find((c) => c.answerTier === "default");
  const compact = candidates.find((c) => c.answerTier === "compact");
  const others = candidates.filter((c) => !c.answerTier);

  const notPicked = (c: AnswerModelCandidate): NotPickedReason => {
    if (tooBigForAutoPick(c, totalRamBytes)) return "low-ram";
    if (!fits(c)) return "wont-fit";
    if (tooSlow(c)) return "too-slow";
    if (!c.answerTier && c.tokPerSec === undefined) return "unmeasured";
    return "outranked";
  };

  let pick: DefaultModelChoice | null = null;
  if (def && !lowRam && fits(def) && !tooSlow(def)) pick = { id: def.id, reason: "default-tier" };
  else if (compact && fits(compact) && !tooSlow(compact)) {
    const reason: PickReason = !def || lowRam ? "compact-low-ram" : tooSlow(def) && fits(def) ? "compact-default-too-slow" : "compact-does-not-fit";
    pick = { id: compact.id, reason };
  } else {
    const allowed = (c: AnswerModelCandidate) => !tooBigForAutoPick(c, totalRamBytes);
    const fast = others.filter((c) => allowed(c) && fits(c) && c.tokPerSec !== undefined && !tooSlow(c)).sort((a, b) => size(b) - size(a))[0];
    if (fast) pick = { id: fast.id, reason: "largest-fast" };
    else {
      // On a low-RAM phone, nothing above the compact size: no pick rather than an OOM kill.
      const smallest = candidates.filter(allowed).sort((a, b) => Number(fits(b)) - Number(fits(a)) || size(a) - size(b))[0];
      pick = smallest ? { id: smallest.id, reason: "smallest-fallback" } : null;
    }
  }

  // Preference order for the rest: default, compact, then the others largest first.
  const order = [def, compact, ...[...others].sort((a, b) => size(b) - size(a))].filter((c): c is AnswerModelCandidate => !!c);
  for (const c of candidates) if (!order.includes(c)) order.push(c);
  const chosen = pick;
  const ranked: RankedAnswerModel[] = [
    ...(chosen ? [{ id: chosen.id, picked: true, reason: chosen.reason }] : []),
    ...order.filter((c) => c.id !== chosen?.id).map((c) => ({ id: c.id, picked: false, reason: notPicked(c) })),
  ];
  return { pick, ranked };
}

/** The automatic answer model (see rankAnswerModels); null when nothing is installed. */
export function pickDefaultAnswerModel(candidates: AnswerModelCandidate[], totalRamBytes: number): DefaultModelChoice | null {
  return rankAnswerModels(candidates, totalRamBytes).pick;
}
