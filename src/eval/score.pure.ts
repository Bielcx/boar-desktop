// Score v1 for one model's answers in an evaluation run: what the "What will be shared" screen
// shows before sending. The server computes the stored score itself from the rows
// (supabase/migrations/*_eval_scores.sql, compute_eval_scores); keep the two in sync, and see
// docs/RESULTS_SCORE.md for why each part is weighted as it is.
import type { EvalResultRow } from "./evalHarness.pure";

export const SCORE_VERSION = 1;
/** Decode speed that earns the full speed part: about three times reading speed. */
export const REFERENCE_TOK_PER_SEC = 20;
/** Shorter answers are mostly prefill and say little about decode speed. */
export const MIN_TOKENS_FOR_SPEED = 16;
export const WEIGHTS = { speed: 0.6, reliability: 0.25, retrieval: 0.15 } as const;
/** Below this share of completed answers the score is 0: a fast model that fails isn't a pick. */
export const MIN_RELIABILITY = 0.5;

export interface ModelScore {
  configId: string;
  modelId?: string;
  modelLabel?: string;
  answers: number;
  completed: number;
  retrievalQuestions: number;
  retrievalHits: number;
  medianTokPerSec?: number;
  medianTtftMs?: number;
  medianTotalMs?: number;
  peakRssBytes?: number;
  /** 0-1 parts. `retrieval` is undefined when no question expected an article. */
  speed: number;
  reliability: number;
  retrieval?: number;
  /** 0-100. */
  score: number;
}

/** Continuous median, like Postgres's percentile_cont(0.5). */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;
}

const completedRow = (r: EvalResultRow) => r.outcome === "success" && !r.timedOut;
const defined = (xs: (number | undefined | null)[]) => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

export function scoreParts(speed: number, reliability: number, retrieval: number | undefined): number {
  if (reliability < MIN_RELIABILITY) return 0;
  const w = WEIGHTS;
  if (retrieval === undefined) {
    const rest = w.speed + w.reliability;
    return Math.round(100 * ((w.speed / rest) * speed + (w.reliability / rest) * reliability));
  }
  return Math.round(100 * (w.speed * speed + w.reliability * reliability + w.retrieval * retrieval));
}

export function scoreConfig(rows: EvalResultRow[]): ModelScore {
  const done = rows.filter(completedRow);
  const withExpected = rows.filter((r) => r.expectedKbHit === true || r.expectedKbHit === false);
  const hits = withExpected.filter((r) => r.expectedKbHit === true).length;
  const medianTokPerSec = median(
    defined(done.filter((r) => (r.tokensGenerated ?? 0) >= MIN_TOKENS_FOR_SPEED && (r.tokPerSec ?? 0) > 0).map((r) => r.tokPerSec))
  );
  const speed = Math.min(1, (medianTokPerSec ?? 0) / REFERENCE_TOK_PER_SEC);
  const reliability = rows.length > 0 ? done.length / rows.length : 0;
  const retrieval = withExpected.length > 0 ? hits / withExpected.length : undefined;
  const peaks = defined(rows.map((r) => r.peakRssBytes));
  return {
    configId: rows[0]?.configId ?? "",
    modelId: rows.find((r) => r.modelId)?.modelId,
    modelLabel: rows.find((r) => r.configLabel)?.configLabel,
    answers: rows.length,
    completed: done.length,
    retrievalQuestions: withExpected.length,
    retrievalHits: hits,
    medianTokPerSec,
    medianTtftMs: median(defined(done.map((r) => r.ttftMs))),
    medianTotalMs: median(defined(done.map((r) => r.totalLatencyMs))),
    peakRssBytes: peaks.length > 0 ? Math.max(...peaks) : undefined,
    speed,
    reliability,
    retrieval,
    score: scoreParts(speed, reliability, retrieval),
  };
}

/** One score per configuration in the run, best first. */
export function scoreRun(rows: EvalResultRow[]): ModelScore[] {
  const byConfig = new Map<string, EvalResultRow[]>();
  for (const r of rows) byConfig.set(r.configId, [...(byConfig.get(r.configId) ?? []), r]);
  return Array.from(byConfig.values(), scoreConfig).sort((a, b) => b.score - a.score);
}
