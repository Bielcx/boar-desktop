// The signed payload of a shared run: { run: {...}, rows: [<eval JSONL row>, ...] }, checked and
// turned into what submit_eval_run() stores. Anything malformed is refused or dropped here; the
// database then checks the questions, limits and plausibility.
// A real run is 17 questions per model, about 2.6 KB a row (44 KB for one model). Room for 12
// models; answers are capped at 512 tokens, about 2,500 characters.
const MAX_ROWS = 204;
const MAX_ANSWER_CHARS = 4000;
/** Words shown on the public scores: letters, digits, spaces and a few separators, nothing else. */
const LABEL = /^[\p{L}\p{N} ._+\-/(),:]+$/u;

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};
const posInt = (v: unknown, max: number): number | null => {
  const n = int(v);
  return n !== null && n > 0 && n <= max ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** A short public label (phone, chip, model): bounded and limited to LABEL's characters. */
const label = (v: unknown, max: number): string | null => {
  const s = str(v, max);
  return s !== null && LABEL.test(s) ? s : null;
};
/** Up to `n` strings of at most `max` characters; anything else is dropped. */
const strs = (v: unknown, n: number, max: number): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= max).slice(0, n) : null;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
/** Short lowercase CPU flags like "i8mm" or "asimddp", at most 100 of them. None (iOS reports no
 * flags) is unknown, not "no i8mm or dotprod", so it's stored as null. */
const cpuFlags = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const flags = v.filter((f) => typeof f === "string" && /^[a-z0-9_]{1,32}$/.test(f)).slice(0, 100);
  return flags.length > 0 ? flags : null;
};
/** Core frequencies in kHz (0 = unknown), at most 64 cores. */
const freqs = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length <= 64 && v.every((f) => Number.isInteger(f) && f >= 0 && f < 10_000_000) ? v : null;
/** A time in milliseconds: finite, not negative, under a day. */
const ms = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && n < 86_400_000 ? n : null;
};

export type Parsed = { run: Record<string, unknown>; rows: Record<string, unknown>[] } | { error: string };

export function parsePayload(payload: string, platform: "android" | "ios"): Parsed {
  let body: any;
  try {
    body = JSON.parse(payload);
  } catch {
    return { error: "payload is not JSON" };
  }
  const run = body?.run ?? {};
  const rows: unknown[] = Array.isArray(body?.rows) ? body.rows : [];
  const runId = str(run.runId, 100);
  const evalSetVersion = str(run.evalSetVersion, 20);
  const appVersion = label(run.appVersion, 40);
  if (!runId || !evalSetVersion || !appVersion) {
    return { error: "run.runId, run.evalSetVersion and run.appVersion are required" };
  }
  // The platform comes from the attested key, not from what the payload claims.
  if (run.platform !== platform) return { error: "run.platform doesn't match the device" };
  if (rows.length === 0 || rows.length > MAX_ROWS) return { error: `rows must hold 1 to ${MAX_ROWS} items` };

  const records = [];
  for (const r of rows as any[]) {
    const queryId = str(r?.queryId, 100);
    const configId = str(r?.configId, 200);
    const outcome = str(r?.outcome, 40);
    if (!queryId || !configId || !outcome) return { error: "each row needs queryId, configId and outcome" };
    if (r.runId !== undefined && r.runId !== runId) return { error: "rows belong to another run" };
    // Only these fields are stored, each checked, whatever else the row carries. The question text
    // isn't kept: the server has it (eval_set_queries). compute_eval_scores casts tokensGenerated
    // (a Postgres int, so at most 2^31 - 1), peakRssBytes, timedOut, expectedKbHit and configLabel.
    const tokens = int(r.tokensGenerated);
    const data = {
      queryId,
      configId,
      outcome,
      configLabel: label(r.configLabel, 120),
      modelId: str(r.modelId, 200),
      routingPreset: str(r.routingPreset, 40),
      personalityId: str(r.personalityId, 40),
      maxTokens: posInt(r.maxTokens, 100_000),
      category: str(r.category, 40),
      taskType: str(r.taskType, 40),
      promptFormat: str(r.promptFormat, 40),
      adaptiveRoutingUsed: bool(r.adaptiveRoutingUsed),
      retrievalUsed: bool(r.retrievalUsed),
      retrievedTitles: strs(r.retrievedTitles, 20, 200),
      expectedKbTitles: strs(r.expectedKbTitles, 20, 200),
      expectedKbHit: bool(r.expectedKbHit),
      reasonCodes: strs(r.reasonCodes, 20, 100),
      modelSwitches: int(r.modelSwitches),
      crossMessageModelSwitch: bool(r.crossMessageModelSwitch),
      modelResidency: oneOf(r.modelResidency, ["cold", "resident", "switched"] as const),
      modelLoadMs: ms(r.modelLoadMs),
      generationLatencyMs: ms(r.generationLatencyMs),
      tokensGenerated: tokens !== null && tokens <= 2_147_483_647 ? tokens : null,
      peakRssBytes: int(r.peakRssBytes),
      timedOut: bool(r.timedOut),
      errorMessage: str(r.errorMessage, 500),
      answer: typeof r.answer === "string" ? r.answer.slice(0, MAX_ANSWER_CHARS) : null,
      createdAt: int(r.createdAt),
    };
    const tokPerSec = num(r.tokPerSec);
    records.push({
      query_id: queryId,
      config_id: configId,
      model_id: str(r.modelId, 200),
      outcome,
      ttft_ms: ms(r.ttftMs),
      tok_per_sec: tokPerSec !== null && tokPerSec >= 0 && tokPerSec < 100_000 ? tokPerSec : null,
      total_latency_ms: ms(r.totalLatencyMs),
      data,
    });
  }

  return {
    run: {
      run_id: runId,
      eval_set_version: evalSetVersion,
      app_version: appVersion,
      platform,
      os_version: label(run.osVersion, 40),
      device_brand: label(run.deviceBrand, 80),
      device_model: label(run.deviceModel, 80),
      soc: label(run.soc, 80),
      soc_manufacturer: label(run.socManufacturer, 80),
      hardware: label(run.hardware, 80),
      api_level: posInt(run.apiLevel, 1000),
      ram_bytes: posInt(run.ramBytes, 2 ** 43),
      cpu_cores: posInt(run.cpuCores, 256),
      cpu_features: cpuFlags(run.cpuFeatures),
      core_max_khz: freqs(run.coreMaxFreqKHz),
    },
    rows: records,
  };
}
