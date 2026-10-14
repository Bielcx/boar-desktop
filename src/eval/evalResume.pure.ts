/**
 * What an evaluation run keeps on disk so it survives the app being closed: a small manifest
 * (eval/<runId>.run.json) next to the rows (eval/<runId>.jsonl), both rewritten as each answer
 * finishes. Android kills the app outright when a big model doesn't fit in memory, and nothing
 * after that runs, so the manifest names the answer in progress *before* it starts: if it is
 * still set on the next launch, that answer is the one the app died on.
 */
import type { EvalQuery } from "./evalSet";
import { evalConfigId, type EvalConfig, type EvalResultRow } from "./evalHarness.pure";

export interface EvalRunManifest {
  runId: string;
  evalSetVersion: string;
  configs: EvalConfig[];
  queryIds: string[];
  startedAt: number;
  /** Set before each answer, cleared after it: still set on launch = the app died during it. */
  inFlight?: { configId: string; queryId: string };
  /** Set when the run ended normally (finished or stopped). */
  endedAt?: number;
  stopped?: boolean;
  sharedAt?: number;
}

/** Recorded on the answers the app was closed during, and the rest of that model's answers. */
export const KILLED_ERROR = "The app was closed while this model was running, probably because it ran out of memory.";

const key = (configId: string, queryId: string) => `${configId}/${queryId}`;

/** The (config, query) pairs still to answer, in run order. */
export function remainingWork(manifest: EvalRunManifest, rows: EvalResultRow[], queries: EvalQuery[]): Array<{ config: EvalConfig; query: EvalQuery }> {
  const done = new Set(rows.map((r) => key(r.configId, r.queryId)));
  const byId = new Map(queries.map((q) => [q.id, q]));
  const out: Array<{ config: EvalConfig; query: EvalQuery }> = [];
  for (const config of manifest.configs) {
    for (const id of manifest.queryIds) {
      const query = byId.get(id);
      if (query && !done.has(key(evalConfigId(config), id))) out.push({ config, query });
    }
  }
  return out;
}

/**
 * After the app died during an answer: failure rows for that answer and the rest of its model's
 * answers, so continuing doesn't load the same model and die again. The phone's result for that
 * model is then an honest "couldn't run it", not a gap.
 */
export function killedRows(manifest: EvalRunManifest, rows: EvalResultRow[], queries: EvalQuery[], now = Date.now()): EvalResultRow[] {
  const at = manifest.inFlight;
  if (!at) return [];
  const config = manifest.configs.find((c) => evalConfigId(c) === at.configId);
  // The app died between answers (after saving one, before clearing inFlight): nothing was lost.
  if (!config || rows.some((r) => r.configId === at.configId && r.queryId === at.queryId)) return [];
  return remainingWork(manifest, rows, queries)
    .filter((w) => evalConfigId(w.config) === at.configId)
    .map(({ query }) => ({
      runId: manifest.runId,
      evalSetVersion: manifest.evalSetVersion,
      configId: at.configId,
      configLabel: config.label,
      personalityId: rows[0]?.personalityId ?? "",
      maxTokens: rows[0]?.maxTokens ?? 0,
      queryId: query.id,
      category: query.category,
      query: query.query,
      modelId: config.kind === "model" ? config.modelId : undefined,
      adaptiveRoutingUsed: config.kind === "adaptive",
      answer: "",
      retrievedTitles: [],
      expectedKbTitles: query.expectedKbTitles,
      expectedKbHit: query.expectedKbTitles.length === 0 ? null : false,
      timedOut: false,
      outcome: "failure" as const,
      errorMessage: KILLED_ERROR,
      createdAt: now,
    }));
}

export type RunState = "unfinished" | "ended";

/** A run on disk: unfinished (the app died, or is mid-run elsewhere) or ended. */
export function runState(manifest: EvalRunManifest): RunState {
  return manifest.endedAt ? "ended" : "unfinished";
}

/** Rows from a saved .jsonl, skipping a line cut short by the app dying mid-write. */
export function parseEvalRows(jsonl: string): EvalResultRow[] {
  const rows: EvalResultRow[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.configId === "string" && typeof r.queryId === "string") rows.push(r);
    } catch {
      // A torn last line: that answer is simply run again.
    }
  }
  // One row per answer: a row written twice (a retry after a torn write) keeps the last.
  const byKey = new Map(rows.map((r) => [key(r.configId, r.queryId), r]));
  return [...byKey.values()];
}

export function parseManifest(json: string): EvalRunManifest | null {
  try {
    const m = JSON.parse(json);
    return m && typeof m.runId === "string" && Array.isArray(m.configs) && Array.isArray(m.queryIds) ? m : null;
  } catch {
    return null;
  }
}

/** Run ids newest first, from eval/ file names ("<runId>.run.json", or its ".tmp" left by a kill). Run ids sort by time. */
export function savedRunIds(files: string[]): string[] {
  const ids = new Set(files.map((f) => /^(.+)\.run\.json(\.tmp)?$/.exec(f)?.[1]).filter((id): id is string => !!id));
  return [...ids].sort().reverse();
}
