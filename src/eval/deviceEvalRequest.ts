/**
 * The app side of the device evaluation CLI (scripts/eval-device.mjs). The
 * CLI writes a request to files/eval/requests/pending.json over
 * `adb ... run-as`; the app (development builds only, see ChatScreen.tsx)
 * picks it up, runs it through the same runEvaluation() the Evaluation
 * screen uses, and reports progress in files/eval/requests/<requestId>.status.json,
 * which the CLI polls. The app never talks to adb itself.
 */
import * as FileSystem from "expo-file-system/legacy";
import { getRoutingPreset } from "../models/settings";
import { EVAL_SET, VITALIK_SET } from "./evalSet";
import { EVAL_RESULTS_DIR, listInstalledEvalModels, runEvaluation, RunEvaluationOptions, EvaluationRun } from "./evalHarness";
import { evalConfigId } from "./evalHarness.pure";
import { blockedEvalModels, EvalRequest, EvalRequestStatus, parseEvalRequest, resolveAnswerRequest, resolveEvalRequest, UNDERSTOOD_FIELDS } from "./deviceEvalRequest.pure";
import { getDeviceTotalRamBytes } from "ram-monitor";
import { confirmLargeModel, getAnswerSettings } from "../models/settings";
import { installForEval, runAnswerEvaluation } from "./answerEval";
import { DEVICE_EVAL_ON } from "./deviceEvalGate";

export const EVAL_REQUESTS_DIR = `${EVAL_RESULTS_DIR}requests/`;
const PENDING_PATH = `${EVAL_REQUESTS_DIR}pending.json`;

async function writeStatus(status: Omit<EvalRequestStatus, "updatedAt">): Promise<void> {
  await FileSystem.makeDirectoryAsync(EVAL_REQUESTS_DIR, { intermediates: true }).catch(() => {});
  await FileSystem.writeAsStringAsync(
    `${EVAL_REQUESTS_DIR}${status.requestId}.status.json`,
    JSON.stringify({ ...status, updatedAt: Date.now() })
  );
}

/** Path relative to the app's data directory, the form `adb exec-out run-as <pkg> cat` takes. */
function toRunAsPath(uri: string): string {
  const docs = FileSystem.documentDirectory ?? "";
  return uri.startsWith(docs) ? `files/${uri.slice(docs.length)}` : uri;
}

/**
 * Claims the pending request, if any: deletes the file so it runs once.
 * An unreadable request is answered with a "failed" status instead of
 * being silently dropped.
 */
export async function takePendingEvalRequest(): Promise<EvalRequest | null> {
  // A shipped build neither reads requests nor creates their folder (src/eval/deviceEvalGate.ts).
  if (!DEVICE_EVAL_ON) return null;
  // The folder exists from the first check on, so a devicectl copy into it (iOS) has a destination.
  await FileSystem.makeDirectoryAsync(EVAL_REQUESTS_DIR, { intermediates: true }).catch(() => {});
  const info = await FileSystem.getInfoAsync(PENDING_PATH);
  if (!info.exists) return null;
  const text = await FileSystem.readAsStringAsync(PENDING_PATH);
  await FileSystem.deleteAsync(PENDING_PATH, { idempotent: true });
  try {
    return parseEvalRequest(text);
  } catch (e: any) {
    const id = /"requestId"\s*:\s*"([a-z0-9-]{1,64})"/.exec(text)?.[1] ?? "invalid";
    await writeStatus({ requestId: id, state: "failed", error: `invalid request: ${e?.message ?? e}` });
    console.warn("[EVAL] rejected invalid device request:", e?.message ?? e);
    return null;
  }
}

export async function rejectEvalRequest(request: EvalRequest, error: string): Promise<void> {
  await writeStatus({ requestId: request.requestId, state: "failed", error });
}

/**
 * Resolves the request against what's installed and runs it. Callbacks are
 * passed through to runEvaluation so the Evaluation screen can show the
 * same progress as for a manual run.
 */
export async function runDeviceEvalRequest(
  request: EvalRequest,
  adaptiveLabel: (preset: string) => string,
  callbacks: Pick<RunEvaluationOptions, "onProgress" | "onRow" | "shouldStop"> = {}
): Promise<EvaluationRun | null> {
  const { requestId } = request;
  const [installed, preset] = await Promise.all([listInstalledEvalModels(), getRoutingPreset()]);
  const installedModels = installed.map((m) => m.id);
  if (request.pipeline === "answer") return runAnswerRequest(request, installed, installedModels, callbacks);
  const resolved = resolveEvalRequest(request, installed, EVAL_SET, adaptiveLabel(preset), VITALIK_SET);
  if (!resolved.ok) {
    await writeStatus({ requestId, state: "failed", error: resolved.error, installedModels });
    return null;
  }

  const configs = resolved.configs.map(evalConfigId);
  const total = resolved.configs.length * resolved.queries.length;
  let completed = 0;
  let current: string | undefined;
  // One queue for every write, so a progress update can never land after "done".
  let writes = Promise.resolve();
  const queueStatus = (status: Omit<EvalRequestStatus, "updatedAt">) => {
    writes = writes.then(() => writeStatus(status)).catch(() => {});
    return writes;
  };
  await queueStatus({ requestId, state: "accepted", configs, total, completed, installedModels });
  console.log(`[EVAL] device request ${requestId}: ${configs.join(", ")} x ${resolved.queries.length} queries`);

  try {
    const run = await runEvaluation({
      configs: resolved.configs,
      queries: resolved.queries,
      shouldStop: callbacks.shouldStop,
      onProgress: (p) => {
        current = `${evalConfigId(p.config)} / ${p.query.id}`;
        queueStatus({ requestId, state: "running", configs, total, completed, current, installedModels });
        callbacks.onProgress?.(p);
      },
      onRow: (row) => {
        completed += 1;
        queueStatus({ requestId, state: "running", configs, total, completed, current, installedModels });
        callbacks.onRow?.(row);
      },
    });
    await queueStatus({
      requestId,
      state: "done",
      configs,
      total,
      completed: run.rows.length,
      runId: run.runId,
      resultPath: toRunAsPath(run.savedPath),
      stopped: run.stopped,
      installedModels,
    });
    return run;
  } catch (e: any) {
    await queueStatus({ requestId, state: "failed", configs, total, completed, error: e?.message ?? String(e), installedModels });
    throw e;
  }
}

/** Pipeline "answer": the live answer() over the request's questions (answerEval.ts), same status protocol. */
async function runAnswerRequest(
  request: EvalRequest,
  installedBefore: Awaited<ReturnType<typeof listInstalledEvalModels>>,
  installedModelsBefore: string[],
  callbacks: Pick<RunEvaluationOptions, "onProgress" | "onRow" | "shouldStop">
): Promise<EvaluationRun | null> {
  const { requestId } = request;
  let installed = installedBefore;
  let installedModels = installedModelsBefore;
  let writes = Promise.resolve();
  // Every status carries the fields this build understood: the CLI may first read one after "accepted".
  const queueStatus = (status: Omit<EvalRequestStatus, "updatedAt">) => {
    writes = writes.then(() => writeStatus({ ...status, understood: UNDERSTOOD_FIELDS })).catch(() => {});
    return writes;
  };
  // Downloads first, so a request can install the model it then evaluates (e.g. Qwen3-4B on a phone without it).
  let install: EvalRequestStatus["install"];
  if (request.install) {
    await queueStatus({ requestId, state: "accepted", installedModels });
    install = await installForEval(request.install, (line) => {
      console.log(`[EVAL] ${line}`);
      queueStatus({ requestId, state: "running", current: line, installedModels });
    });
    installed = await listInstalledEvalModels();
    installedModels = installed.map((m) => m.id);
  }
  const resolved = resolveAnswerRequest(request, installed, EVAL_SET);
  if (!resolved.ok) {
    await queueStatus({ requestId, state: "failed", error: resolved.error, installedModels, install });
    return null;
  }
  // F1: a requested model answer() would replace (low RAM, unconfirmed; or crashed on load) fails the request.
  const entries = resolved.models.map((m) => installed.find((i) => i.id === m.id)).filter((m): m is (typeof installed)[number] => !!m);
  let ram = 0;
  try {
    ram = getDeviceTotalRamBytes();
  } catch {}
  const blocked = blockedEvalModels(entries, ram, await getAnswerSettings(), request.confirmLargeModels === true);
  if (blocked.length) {
    const why = blocked
      .map((b) => (b.reason === "load-crashed" ? `${b.id} crashed the app on its last load` : `${b.id} is too big for this phone's RAM without a confirmation (send "confirmLargeModels": true, or confirm it once in Models)`))
      .join("; ");
    await queueStatus({ requestId, state: "failed", error: `requested model would not run: ${why}`, installedModels, install });
    return null;
  }
  if (request.confirmLargeModels) {
    for (const m of entries) await confirmLargeModel(m.id).catch(() => {});
  }
  const configs = resolved.models.length ? resolved.models.map((m) => `answer:${m.id}`) : ["answer:current"];
  const total = configs.length * resolved.questions.length;
  let completed = 0;
  let current: string | undefined;
  await queueStatus({ requestId, state: "accepted", configs, total, completed, installedModels });
  console.log(`[EVAL] device request ${requestId} (answer pipeline): ${configs.join(", ")} x ${resolved.questions.length} questions`);
  try {
    const run = await runAnswerEvaluation({
      answerSettings: request.answerSettings,
      // A re-sent request (same id) resumes where a killed run stopped.
      resumeKey: requestId,
      questions: resolved.questions,
      models: resolved.models,
      answerAnyway: request.answerAnyway,
      evalSetVersion: request.evalSetVersion,
      shouldStop: callbacks.shouldStop,
      onProgress: (p) => {
        current = `${configs[p.configIndex]} / ${p.query.id}`;
        queueStatus({ requestId, state: "running", configs, total, completed, current, installedModels });
        callbacks.onProgress?.(p);
      },
      onRow: (row) => {
        // A declined answer plus its "Answer anyway" re-ask is one question.
        if (!row.answeredAnyway) completed += 1;
        queueStatus({ requestId, state: "running", configs, total, completed, current, installedModels });
        callbacks.onRow?.(row);
      },
    });
    await queueStatus({
      requestId,
      state: "done",
      configs,
      total,
      completed,
      runId: run.runId,
      resultPath: toRunAsPath(run.savedPath),
      stopped: run.stopped,
      installedModels,
      install,
    });
    return run;
  } catch (e: any) {
    await queueStatus({ requestId, state: "failed", configs, total, completed, error: e?.message ?? String(e), installedModels });
    throw e;
  }
}
