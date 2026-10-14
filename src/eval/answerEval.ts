/**
 * Runs questions through the live answer pipeline (answerService.answer, the
 * one the chat calls) and saves one AnswerEvalRow per question. Driven by a
 * device request (deviceEvalRequest.ts, pipeline "answer"); the rows keep the
 * EvalResultRow shape, so the Evaluation screen and the desktop judge/report
 * scripts (eval/scripts) read them unchanged.
 *
 * Fixed prompt (the default personality, no history, DEFAULT_MAX_TOKENS) so
 * runs on different days or devices are comparable; the answer settings
 * (quick first / always complete) are the device's and recorded on every row.
 */
import * as FileSystem from "expo-file-system/legacy";
import { answer } from "../routing/answerService";
import type { AnswerEvent, AnswerResult } from "../routing/events";
import { DEFAULT_MAX_TOKENS, getActiveModelId, getAnswerSettings, setActiveModelId, setAnswerSettings } from "../models/settings";
import { findAsset } from "../models/assetRegistry";
import { ModelManager } from "../models/ModelManager";
import { resolvePlace, tilesFor } from "../rag/pois";
import { getDownloadState, startDownload } from "../services/downloadManager";
import { nameTilesAfter } from "../rag/placeTileNames";
// The packs' catalog entries register when their module loads; load them here so install.assets can
// find them without the Knowledge screen opened first. The English Wikipedia and Wikivoyage entries
// (wikiEnPacks) aren't in the app's catalog, so they're only loaded when a benchmark installs (below).
import "../rag/cryptoPack";
import "../rag/preparedness";
import "../rag/poiRegions";
import { DEFAULT_PERSONALITY_ID, getPersonality } from "../constants/personalities";
import { EVAL_RESULTS_DIR, EvalProgress } from "./evalHarness";
import { EvalConfig, evalRowsToJsonl, newEvalRunId } from "./evalHarness.pure";
import type { EvalCategory } from "./evalSet";
import { AnswerEvalRow, buildAnswerEvalRow, EvalQuestion, oldestRestorePoint, parseResultRows, RestorePoint, resultKey, resumableRows, TimedEvent } from "./answerEval.pure";

export const ANSWER_TIMEOUT_MS = 240_000;
/** Pause between questions: lets the engine's idle prefix refill run, as between two questions in the chat. */
const GAP_MS = 1_500;

/** Places areas are downloaded around the city's point, as the chat's "get this city" offer does (CityMapOffer). */
const CITY_AREA_KM = 15;

export interface EvalInstall {
  /** City names (resolved with the world gazetteer): their places tiles are downloaded. */
  places?: string[];
  /** Catalog ids (e.g. boar-crypto, boar-wikivoyage-en), downloaded if not on the phone. */
  assets?: string[];
}

export interface InstallReport {
  installed: string[];
  already: string[];
  failed: { id: string; error: string }[];
}

/**
 * Downloads what a run needs before its first question, so a pack A/B needs no UI.
 * Sequential and awaited; a failure is reported, not thrown, and the run goes on.
 */
export async function installForEval(spec: EvalInstall, log: (line: string) => void = () => {}): Promise<InstallReport> {
  // Only in a device benchmark: registering these in every build would put 15 Wikipedia shards in the catalog.
  require("../rag/wikiEnPacks");
  const report: InstallReport = { installed: [], already: [], failed: [] };
  const manager = new ModelManager();
  const fetchOne = async (asset: NonNullable<ReturnType<typeof findAsset>>) => {
    if ((await manager.statusOf(asset)).present || getDownloadState(asset.id)?.phase === "verified") {
      report.already.push(asset.id);
      return;
    }
    try {
      log(`installing ${asset.id} (${Math.round(asset.sizeBytes / 1e6)} MB)`);
      await startDownload(asset);
      report.installed.push(asset.id);
    } catch (e: any) {
      report.failed.push({ id: asset.id, error: e?.message ?? String(e) });
    }
  };
  for (const id of spec.assets ?? []) {
    const asset = findAsset(id);
    if (!asset) report.failed.push({ id, error: "not in the catalog" });
    else await fetchOne(asset);
  }
  for (const name of spec.places ?? []) {
    try {
      const city = await resolvePlace(name);
      if (!city) {
        report.failed.push({ id: `places:${name}`, error: "city not found in the gazetteer" });
        continue;
      }
      const tiles = await tilesFor(city.lat, city.lon, CITY_AREA_KM);
      if (!tiles.length) {
        report.failed.push({ id: `places:${name}`, error: "no published tiles for this area" });
        continue;
      }
      await nameTilesAfter(city.name, tiles).catch(() => {});
      for (const tile of tiles) await fetchOne(tile);
    } catch (e: any) {
      report.failed.push({ id: `places:${name}`, error: e?.message ?? String(e) });
    }
  }
  log(`install: ${report.installed.length} new, ${report.already.length} already there, ${report.failed.length} failed`);
  return report;
}

export interface RunAnswerEvaluationOptions {
  questions: EvalQuestion[];
  /** Models to answer with; empty = whatever the chat would use now (config "adaptive"). */
  models?: { id: string; label: string }[];
  /** A declined answer (weak sources) is asked again with answerAnyway, like tapping "Answer anyway". */
  answerAnyway?: boolean;
  evalSetVersion?: string;
  /** Answer settings for this run only (quick first / always complete); the device's are restored after. */
  answerSettings?: { quickFirst?: boolean; alwaysComplete?: boolean };
  /**
   * The request id: results go to <resumeKey>.answer.jsonl, and a re-sent request with the same id
   * (e.g. after the OS killed the app mid-run) skips the questions that file already answers. The
   * device's model and answer settings are kept in <resumeKey>.restore.json until the run ends, so a
   * resumed run restores the originals, not the values the killed run had set.
   */
  resumeKey?: string;
  onProgress?: (p: EvalProgress) => void;
  onRow?: (row: AnswerEvalRow) => void;
  shouldStop?: () => boolean;
}

export interface AnswerEvaluationRun {
  runId: string;
  rows: AnswerEvalRow[];
  savedPath: string;
  stopped: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function askOnce(query: string, answerAnyway: boolean, shouldStop?: () => boolean, collections?: string[]) {
  const personality = getPersonality(DEFAULT_PERSONALITY_ID);
  const events: TimedEvent[] = [];
  const t0 = performance.now();
  const handle = answer(
    { query, answerAnyway: answerAnyway || undefined, ...(collections?.length ? { collections } : {}) },
    (event: AnswerEvent) => events.push({ atMs: performance.now() - t0, event }),
    { systemPrompt: personality.systemPrompt, styleReminder: personality.styleReminder, maxTokens: DEFAULT_MAX_TOKENS }
  );
  let result: AnswerResult | null = null;
  let error: string | undefined;
  const watch = setInterval(() => {
    if (shouldStop?.()) handle.stop().catch(() => {});
  }, 500);
  try {
    result = await Promise.race([
      handle.done,
      sleep(ANSWER_TIMEOUT_MS).then(() => {
        throw new Error(`timeout after ${ANSWER_TIMEOUT_MS / 1000} s`);
      }),
    ]);
  } catch (e: any) {
    error = e?.message ?? String(e);
    await handle.stop().catch(() => {});
  } finally {
    clearInterval(watch);
  }
  return { events, result, error, wallMs: performance.now() - t0 };
}

export async function runAnswerEvaluation({
  questions,
  models = [],
  answerAnyway = false,
  evalSetVersion = "custom",
  answerSettings: settingsOverride,
  resumeKey,
  onProgress,
  onRow,
  shouldStop,
}: RunAnswerEvaluationOptions): Promise<AnswerEvaluationRun> {
  await FileSystem.makeDirectoryAsync(EVAL_RESULTS_DIR, { intermediates: true }).catch(() => {});
  const readJson = async (path: string) =>
    (await FileSystem.getInfoAsync(path)).exists ? await FileSystem.readAsStringAsync(path).catch(() => "") : "";
  const configs: EvalConfig[] = models.length
    ? models.map((m) => ({ kind: "model" as const, modelId: m.id, label: m.label }))
    : [{ kind: "adaptive", label: "current model" }];
  const configIdOf = (c: EvalConfig) => (c.kind === "model" ? `answer:${c.modelId}` : "answer:current");
  // Resume: the finished rows a killed run of this request wrote, for the questions and models asked now
  // (a Stop-cut or declined-without-re-ask answer is asked again).
  const savedPath = `${EVAL_RESULTS_DIR}${resumeKey ?? newEvalRunId()}.answer.jsonl`;
  const current = new Set(configs.flatMap((c) => questions.map((q) => resultKey(configIdOf(c), q.id))));
  const rows: AnswerEvalRow[] = resumeKey ? resumableRows(parseResultRows(await readJson(savedPath)), answerAnyway, current) : [];
  const done = new Set(rows.map((r) => resultKey(r.configId, r.queryId)));
  const runId = rows[0]?.runId ?? newEvalRunId();
  for (const r of rows) onRow?.(r);
  if (rows.length) console.log(`[EVAL] resuming ${resumeKey}: ${done.size} answers already in ${savedPath}`);
  // The device's own model and settings: from the oldest restore point a killed benchmark left (this one's or
  // another request's), else a fresh snapshot. Restored at the end whatever this request's flags are.
  const restorePath = resumeKey ? `${EVAL_RESULTS_DIR}${resumeKey}.restore.json` : null;
  let original: RestorePoint | null = null;
  if (restorePath) {
    const names = await FileSystem.readDirectoryAsync(EVAL_RESULTS_DIR).catch(() => [] as string[]);
    const pending: { path: string; point: RestorePoint }[] = [];
    for (const name of names.filter((n) => n.endsWith(".restore.json"))) {
      try {
        const point = JSON.parse(await readJson(`${EVAL_RESULTS_DIR}${name}`));
        if (point && typeof point.quickFirst === "boolean") pending.push({ path: `${EVAL_RESULTS_DIR}${name}`, point });
      } catch {}
    }
    original = oldestRestorePoint(pending.map((p) => p.point));
    for (const p of pending) if (p.path !== restorePath) await FileSystem.deleteAsync(p.path, { idempotent: true }).catch(() => {});
  }
  if (!original) {
    const now = await getAnswerSettings();
    original = { model: await getActiveModelId("llm"), quickFirst: now.quickFirst, alwaysComplete: now.alwaysComplete, savedAt: Date.now() };
  }
  if (restorePath) await FileSystem.writeAsStringAsync(restorePath, JSON.stringify(original));
  const savedModel = original.model;
  const savedSettings = original;
  if (settingsOverride) await setAnswerSettings(settingsOverride);
  const answerSettings = { ...(await getAnswerSettings()) } as Record<string, unknown>;
  let stopped = false;

  try {
    outer: for (const [ci, config] of configs.entries()) {
      if (config.kind === "model") await setActiveModelId("llm", config.modelId);
      const configId = config.kind === "model" ? `answer:${config.modelId}` : "answer:current";
      for (const [qi, q] of questions.entries()) {
        if (shouldStop?.()) {
          stopped = true;
          break outer;
        }
        if (done.has(resultKey(configId, q.id))) continue;
        onProgress?.({
          configIndex: ci,
          configCount: configs.length,
          queryIndex: qi,
          queryCount: questions.length,
          config,
          query: { id: q.id, category: (q.category ?? "custom") as EvalCategory, query: q.query, expectedKbTitles: [], gradingNotes: "" },
        });
        const meta = {
          runId,
          evalSetVersion,
          configId,
          configLabel: config.label,
          personalityId: DEFAULT_PERSONALITY_ID,
          maxTokens: DEFAULT_MAX_TOKENS,
          answerSettings,
        };
        const first = await askOnce(q.query, false, shouldStop, q.collections);
        const row = buildAnswerEvalRow(q, first.events, first.result, first.wallMs, { ...meta, answeredAnyway: false, createdAt: Date.now() }, first.error);
        rows.push(row);
        onRow?.(row);
        if (row.declined && answerAnyway && !shouldStop?.()) {
          await sleep(GAP_MS);
          const again = await askOnce(q.query, true, shouldStop, q.collections);
          const row2 = buildAnswerEvalRow(q, again.events, again.result, again.wallMs, { ...meta, answeredAnyway: true, createdAt: Date.now() }, again.error);
          rows.push(row2);
          onRow?.(row2);
        }
        // Partial results survive a crash or a stop: rewrite the file after every question.
        await FileSystem.writeAsStringAsync(savedPath, evalRowsToJsonl(rows));
        console.log(`[EVAL] ${configId} ${q.id} ${row.outcome} tier=${row.tier} ttft=${row.ttftMs ?? "-"} total=${row.totalLatencyMs ?? "-"}`);
        await sleep(GAP_MS);
      }
    }
  } finally {
    // A device request (restorePath) always puts back the restore point, whatever this request's flags: a
    // resumed or later run may carry none of the killed run's --models / answer settings (F2).
    if ((restorePath || models.length) && savedModel) await setActiveModelId("llm", savedModel).catch(() => {});
    if (restorePath || settingsOverride) {
      await setAnswerSettings({ quickFirst: savedSettings.quickFirst, alwaysComplete: savedSettings.alwaysComplete }).catch(() => {});
    }
    if (restorePath) await FileSystem.deleteAsync(restorePath, { idempotent: true }).catch(() => {});
  }
  await FileSystem.writeAsStringAsync(savedPath, evalRowsToJsonl(rows));
  console.log(`[EVAL] answer run ${runId} ${stopped ? "stopped" : "done"} — ${rows.length} rows saved to ${savedPath}`);
  return { runId, rows, savedPath, stopped };
}
