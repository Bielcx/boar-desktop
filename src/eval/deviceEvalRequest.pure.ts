/**
 * Evaluation requests sent from a development machine (scripts/eval-device.mjs)
 * by writing a JSON file into the app's private storage over adb. Parsing
 * and resolution live here, native-module-free; the file handling is in
 * deviceEvalRequest.ts.
 */
import type { CatalogModel } from "../models/manifest";
import type { EvalConfig } from "./evalHarness.pure";
import type { EvalQuery } from "./evalSet";
import { EvalQuestion, parseQuestions } from "./answerEval.pure";
import { tooBigForLowRam } from "../routing/defaultModel";

export interface EvalRequest {
  requestId: string;
  /** Model selectors: an exact model id, or a fragment of one id/label ("phi-3.5", "instella-moe"). */
  models?: string[];
  /** Include the adaptive-routing config. */
  adaptive?: boolean;
  /** Restrict to these query ids or categories. All queries when absent. */
  queries?: string[];
  /**
   * "legacy" (default): evalHarness.ts, the older executor path, over EVAL_SET.
   * "answer": answerEval.ts, the live answer() the chat uses (routing, places, multi-pass, the device's answer settings).
   */
  pipeline?: "legacy" | "answer";
  /** Pipeline "answer" only: the questions to ask (any dataset). EVAL_SET when absent. */
  questions?: EvalQuestion[];
  /** Pipeline "answer" only: re-ask a declined answer with answerAnyway ("Answer anyway"). */
  answerAnyway?: boolean;
  /** Pipeline "answer" only: dataset label recorded on every row (e.g. "dataset-v2"). */
  evalSetVersion?: string;
  /** Pipeline "answer" only: packs to download before the first question (city places, catalog ids). */
  install?: { places?: string[]; assets?: string[] };
  /** Pipeline "answer" only: confirm requested models a low-RAM phone would otherwise refuse (the UI's "run it anyway"). */
  confirmLargeModels?: boolean;
  /** Pipeline "answer" only: answer settings for this run; the device's are restored after. */
  answerSettings?: { quickFirst?: boolean; alwaysComplete?: boolean };
}

export type EvalRequestState = "accepted" | "running" | "done" | "failed";

export interface EvalRequestStatus {
  requestId: string;
  state: EvalRequestState;
  updatedAt: number;
  configs?: string[];
  total?: number;
  completed?: number;
  current?: string;
  runId?: string;
  /** Path of the JSONL result relative to the app's data directory, for `run-as <pkg> cat`. */
  resultPath?: string;
  stopped?: boolean;
  error?: string;
  installedModels?: string[];
  /** Request fields this build understood (pipeline "answer"): the CLI warns about any it sent that are missing. */
  understood?: string[];
  /** Pipeline "answer" with install: what was downloaded before the run. */
  install?: { installed: string[]; already: string[]; failed: { id: string; error: string }[] };
}

const REQUEST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new Error(`"${field}" must be a list of non-empty strings`);
  }
  return value.map((v: string) => v.trim());
}

export function parseEvalRequest(json: string): EvalRequest {
  const raw = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) throw new Error("request must be a JSON object");
  if (typeof raw.requestId !== "string" || !REQUEST_ID_RE.test(raw.requestId)) {
    throw new Error("requestId must be 1-64 lowercase letters, digits or dashes");
  }
  if (raw.adaptive !== undefined && typeof raw.adaptive !== "boolean") throw new Error('"adaptive" must be a boolean');
  if (raw.pipeline !== undefined && raw.pipeline !== "legacy" && raw.pipeline !== "answer") {
    throw new Error('"pipeline" must be "legacy" or "answer"');
  }
  const answerOnly = ["questions", "answerAnyway", "evalSetVersion", "install", "answerSettings", "confirmLargeModels"].filter((k) => raw[k] !== undefined);
  if (raw.confirmLargeModels !== undefined && typeof raw.confirmLargeModels !== "boolean") throw new Error('"confirmLargeModels" must be a boolean');
  if (raw.pipeline !== "answer" && answerOnly.length) throw new Error(`${answerOnly.join(", ")} need "pipeline": "answer"`);
  if (raw.answerAnyway !== undefined && typeof raw.answerAnyway !== "boolean") throw new Error('"answerAnyway" must be a boolean');
  if (raw.evalSetVersion !== undefined && (typeof raw.evalSetVersion !== "string" || !/^[\w.-]{1,64}$/.test(raw.evalSetVersion))) {
    throw new Error('"evalSetVersion" must be 1-64 letters, digits, dots, dashes or underscores');
  }
  let install: EvalRequest["install"];
  if (raw.install !== undefined) {
    if (typeof raw.install !== "object" || raw.install === null) throw new Error('"install" must be { places?, assets? }');
    install = { places: stringList(raw.install.places, "install.places"), assets: stringList(raw.install.assets, "install.assets") };
  }
  let answerSettings: EvalRequest["answerSettings"];
  if (raw.answerSettings !== undefined) {
    const a = raw.answerSettings;
    const bad = typeof a !== "object" || a === null || Object.entries(a).some(([k, v]) => !["quickFirst", "alwaysComplete"].includes(k) || typeof v !== "boolean");
    if (bad) throw new Error('"answerSettings" must be { quickFirst?: boolean, alwaysComplete?: boolean }');
    answerSettings = { quickFirst: a.quickFirst, alwaysComplete: a.alwaysComplete };
  }
  return {
    install,
    answerSettings,
    confirmLargeModels: raw.confirmLargeModels,
    requestId: raw.requestId,
    models: stringList(raw.models, "models"),
    adaptive: raw.adaptive,
    queries: stringList(raw.queries, "queries"),
    pipeline: raw.pipeline,
    questions: parseQuestions(raw.questions),
    answerAnyway: raw.answerAnyway,
    evalSetVersion: raw.evalSetVersion,
  };
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Exact id first; otherwise every installed model whose id or label contains the selector, ignoring case and punctuation. */
export function matchModels(selector: string, installed: CatalogModel[]): CatalogModel[] {
  const exact = installed.filter((m) => m.id === selector);
  if (exact.length) return exact;
  const needle = normalize(selector);
  return installed.filter((m) => normalize(m.id).includes(needle) || normalize(m.label).includes(needle));
}

export type ResolvedEvalRequest =
  | { ok: true; configs: EvalConfig[]; queries: EvalQuery[] }
  | { ok: false; error: string };

/**
 * No models and no adaptive flag means "everything installed plus adaptive",
 * the same default as the Evaluation screen. Every selector must match
 * exactly one installed model, so a typo or an ambiguous fragment fails
 * loudly instead of silently evaluating something else.
 */
export function resolveEvalRequest(
  request: EvalRequest,
  installed: CatalogModel[],
  evalSet: EvalQuery[],
  adaptiveLabel: string,
  /** Sets only run when asked for by id or category (e.g. "vitalik"). */
  extraSets: EvalQuery[] = []
): ResolvedEvalRequest {
  const everything = !request.models?.length && !request.adaptive;
  const configs: EvalConfig[] = [];
  const models = everything ? installed : [];
  if (!everything) {
    for (const selector of request.models ?? []) {
      const matches = matchModels(selector, installed);
      if (matches.length !== 1) {
        const detail = matches.length === 0 ? "matches no installed model" : `is ambiguous (${matches.map((m) => m.id).join(", ")})`;
        return { ok: false, error: `model "${selector}" ${detail}` };
      }
      if (!models.some((m) => m.id === matches[0].id)) models.push(matches[0]);
    }
  }
  for (const m of models) configs.push({ kind: "model", modelId: m.id, label: m.label });
  if (everything || request.adaptive) configs.push({ kind: "adaptive", label: adaptiveLabel });

  let queries = evalSet;
  if (request.queries?.length) {
    const all = [...evalSet, ...extraSets];
    const unknown = request.queries.filter((s) => !all.some((q) => q.id === s || q.category === s));
    if (unknown.length) return { ok: false, error: `unknown query id or category: ${unknown.join(", ")}` };
    queries = all.filter((q) => request.queries!.includes(q.id) || request.queries!.includes(q.category));
  }
  return { ok: true, configs, queries };
}

export type ResolvedAnswerRequest =
  | { ok: true; models: { id: string; label: string }[]; questions: EvalQuestion[] }
  | { ok: false; error: string };

/**
 * Pipeline "answer": no models = the model the chat would use now. Every
 * selector must match exactly one installed model, as for the legacy path.
 * "queries" filters the questions (from the request, or EVAL_SET) by id or category.
 */
export function resolveAnswerRequest(request: EvalRequest, installed: CatalogModel[], evalSet: EvalQuery[]): ResolvedAnswerRequest {
  const models: { id: string; label: string }[] = [];
  for (const selector of request.models ?? []) {
    const matches = matchModels(selector, installed);
    if (matches.length !== 1) {
      const detail = matches.length === 0 ? "matches no installed model" : `is ambiguous (${matches.map((m) => m.id).join(", ")})`;
      return { ok: false, error: `model "${selector}" ${detail}` };
    }
    if (!models.some((m) => m.id === matches[0].id)) models.push({ id: matches[0].id, label: matches[0].label });
  }
  let questions: EvalQuestion[] = request.questions ?? evalSet.map((q) => ({ id: q.id, query: q.query, category: q.category }));
  if (request.queries?.length) {
    const unknown = request.queries.filter((s) => !questions.some((q) => q.id === s || q.category === s));
    if (unknown.length) return { ok: false, error: `unknown query id or category: ${unknown.join(", ")}` };
    questions = questions.filter((q) => request.queries!.includes(q.id) || (q.category !== undefined && request.queries!.includes(q.category)));
  }
  return { ok: true, models, questions };
}

/** Every request field this build reads; echoed in the status so a CLI can spot a build older than its flags. */
export const UNDERSTOOD_FIELDS = ["requestId", "models", "adaptive", "queries", "pipeline", "questions", "answerAnyway", "evalSetVersion", "install", "answerSettings", "confirmLargeModels"];

/**
 * Requested models answer() would silently replace (selectAnswerModel): too big for a low-RAM phone and not
 * confirmed, or recorded as having crashed the app on load. A run on the fallback would be labeled with the
 * requested model, so the request fails instead (or confirms first, for the RAM case, with confirmLargeModels).
 */
export function blockedEvalModels(
  models: CatalogModel[],
  totalRamBytes: number,
  settings: { largeModelConfirmedIds?: string[]; loadCrashedIds?: string[] },
  confirmLarge = false
): { id: string; reason: "low-ram" | "load-crashed" }[] {
  const confirmed = new Set(settings.largeModelConfirmedIds ?? []);
  const crashed = new Set(settings.loadCrashedIds ?? []);
  const out: { id: string; reason: "low-ram" | "load-crashed" }[] = [];
  for (const m of models) {
    if (crashed.has(m.id)) out.push({ id: m.id, reason: "load-crashed" });
    else if (!confirmLarge && !confirmed.has(m.id) && tooBigForLowRam(m as { answerTier?: "default" | "compact"; sizeBytes?: number }, totalRamBytes)) out.push({ id: m.id, reason: "low-ram" });
  }
  return out;
}
