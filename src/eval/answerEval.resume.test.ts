import { beforeEach, describe, expect, it, vi } from "vitest";
import { completedKeys, parseResultRows, resultKey } from "./answerEval.pure";

// In-memory app storage and settings, and an answer() that records what it was asked.
const files = new Map<string, string>();
const asked: string[] = [];
const settings = { quickFirst: true, alwaysComplete: true, model: "device-model" as string | null };
vi.mock("expo-file-system/legacy", () => ({
  makeDirectoryAsync: async () => {},
  getInfoAsync: async (p: string) => ({ exists: files.has(p) }),
  readAsStringAsync: async (p: string) => files.get(p) ?? "",
  writeAsStringAsync: async (p: string, s: string) => void files.set(p, s),
  deleteAsync: async (p: string) => void files.delete(p),
  readDirectoryAsync: async (dir: string) => [...files.keys()].filter((p) => p.startsWith(dir)).map((p) => p.slice(dir.length)),
}));
vi.mock("../routing/answerService", () => ({
  answer: (req: { query: string }, onEvent: (e: any) => void) => {
    asked.push(req.query);
    const receipt = { modelId: settings.model, modelLabel: "m", tokens: 5, tokPerSec: 10, ttftMs: 100, totalMs: 200, reasonCodes: [] };
    onEvent({ type: "token", answerId: "a", tier: "fast", text: `answer to ${req.query}` });
    onEvent({ type: "done", answerId: "a", tier: "fast", outcome: "success", receipt });
    return { answerId: "a", stop: async () => {}, done: Promise.resolve({ answerId: "a", tier: "fast", outcome: "success", text: `answer to ${req.query}`, sources: [], receipt }) };
  },
}));
vi.mock("../models/settings", () => ({
  DEFAULT_MAX_TOKENS: 512,
  getActiveModelId: async () => settings.model,
  setActiveModelId: async (_k: string, id: string) => void (settings.model = id),
  getAnswerSettings: async () => ({ quickFirst: settings.quickFirst, alwaysComplete: settings.alwaysComplete }),
  setAnswerSettings: async (p: { quickFirst?: boolean; alwaysComplete?: boolean }) => void Object.assign(settings, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))),
}));
vi.mock("../models/assetRegistry", () => ({ findAsset: () => undefined }));
vi.mock("../models/ModelManager", () => ({ ModelManager: class {} }));
vi.mock("../rag/pois", () => ({ resolvePlace: async () => null, tilesFor: async () => [] }));
vi.mock("../services/downloadManager", () => ({ getDownloadState: () => undefined, startDownload: async () => {} }));
vi.mock("../rag/placeTileNames", () => ({ nameTilesAfter: async () => {} }));
vi.mock("../rag/wikiEnPacks", () => ({}));
vi.mock("../rag/cryptoPack", () => ({}));
vi.mock("../rag/preparedness", () => ({}));
vi.mock("../rag/poiRegions", () => ({}));
vi.mock("./evalHarness", () => ({ EVAL_RESULTS_DIR: "file:///docs/eval/" }));

const { runAnswerEvaluation } = await import("./answerEval");

const Q = ["q1", "q2", "q3", "q4"].map((id) => ({ id, query: `question ${id}`, category: "crypto-expert" }));
const RESULT = "file:///docs/eval/req-1.answer.jsonl";
const RESTORE = "file:///docs/eval/req-1.restore.json";
const row = (queryId: string, extra: Record<string, unknown> = {}) =>
  ({ runId: "eval-first", configId: "answer:qwen", queryId, answer: "x", declined: false, answeredAnyway: false, outcome: "success", ...extra }) as any;

beforeEach(() => {
  files.clear();
  asked.length = 0;
  Object.assign(settings, { quickFirst: true, alwaysComplete: true, model: "device-model" });
});

describe("result file parsing and completed questions", () => {
  it("skips a line a crash cut short", () => {
    const text = [JSON.stringify(row("q1")), JSON.stringify(row("q2")), '{"runId":"eval-first","configId":"answer:qw'].join("\n");
    expect(parseResultRows(text).map((r) => r.queryId)).toEqual(["q1", "q2"]);
  });

  it("a declined answer is only done with its re-ask when Answer anyway was requested", () => {
    const rows = [row("q1"), row("q2", { declined: true }), row("q3", { declined: true }), row("q3", { answeredAnyway: true })];
    expect([...completedKeys(rows, true)].sort()).toEqual([resultKey("answer:qwen", "q1"), resultKey("answer:qwen", "q3")]);
    expect(completedKeys(rows, false).has(resultKey("answer:qwen", "q2"))).toBe(true);
  });
});

describe("runAnswerEvaluation resume (same request id after the app was killed)", () => {
  it("answers only the questions the killed run didn't finish, keeps its rows and run id, and restores the device's settings", async () => {
    // The killed run: q1 and q2 written, settings switched to quick mode and the model to qwen, never restored.
    files.set(RESULT, [row("q1"), row("q2")].map((r) => JSON.stringify(r)).join("\n"));
    files.set(RESTORE, JSON.stringify({ model: "device-model", quickFirst: true, alwaysComplete: true }));
    Object.assign(settings, { quickFirst: true, alwaysComplete: false, model: "qwen" });

    const seen: string[] = [];
    const run = await runAnswerEvaluation({
      questions: Q,
      models: [{ id: "qwen", label: "Qwen" }],
      answerSettings: { quickFirst: true, alwaysComplete: false },
      resumeKey: "req-1",
      onRow: (r) => seen.push(r.queryId),
    });

    expect(asked).toEqual(["question q3", "question q4"]);
    expect(run.rows.map((r) => r.queryId)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(seen).toEqual(["q1", "q2", "q3", "q4"]);
    expect(run.runId).toBe("eval-first");
    expect(run.savedPath).toBe(RESULT);
    expect(parseResultRows(files.get(RESULT)!).map((r) => r.queryId)).toEqual(["q1", "q2", "q3", "q4"]);
    // The originals from before the first run, not what the killed run left behind.
    expect(settings).toEqual({ quickFirst: true, alwaysComplete: true, model: "device-model" });
    expect(files.has(RESTORE)).toBe(false);
  }, 20000);

  it("a first run keeps the device's settings aside until it ends, then removes that file", async () => {
    const run = await runAnswerEvaluation({ questions: Q.slice(0, 1), answerSettings: { alwaysComplete: false }, resumeKey: "req-1" });
    expect(asked).toEqual(["question q1"]);
    expect(run.savedPath).toBe(RESULT);
    expect(settings.alwaysComplete).toBe(true);
    expect(files.has(RESTORE)).toBe(false);
  }, 20000);

  it("F2: a resend without the killed run's flags still restores the originals", async () => {
    files.set(RESULT, JSON.stringify(row("q1")));
    files.set(RESTORE, JSON.stringify({ model: "device-model", quickFirst: true, alwaysComplete: true, savedAt: 1 }));
    Object.assign(settings, { quickFirst: false, alwaysComplete: false, model: "qwen" });
    await runAnswerEvaluation({ questions: Q.slice(0, 2), resumeKey: "req-1" });
    expect(settings).toEqual({ quickFirst: true, alwaysComplete: true, model: "device-model" });
    expect(files.has(RESTORE)).toBe(false);
  }, 20000);

  it("F2: a new request after a killed one takes the leftover restore point, not the benchmark's values", async () => {
    files.set("file:///docs/eval/req-old.restore.json", JSON.stringify({ model: "device-model", quickFirst: true, alwaysComplete: true, savedAt: 1 }));
    Object.assign(settings, { quickFirst: false, alwaysComplete: false, model: "big-model" });
    await runAnswerEvaluation({ questions: Q.slice(0, 1), models: [{ id: "qwen", label: "Qwen" }], answerSettings: { alwaysComplete: false }, resumeKey: "req-2" });
    expect(settings).toEqual({ quickFirst: true, alwaysComplete: true, model: "device-model" });
    expect([...files.keys()].some((p) => p.endsWith(".restore.json"))).toBe(false);
  }, 20000);

  it("F3: an answer cut off by Stop is asked again on resume", async () => {
    files.set(RESULT, [row("q1"), row("q2", { outcome: "cancelled" })].map((r) => JSON.stringify(r)).join("\n"));
    const run = await runAnswerEvaluation({ questions: Q.slice(0, 2), models: [{ id: "qwen", label: "Qwen" }], resumeKey: "req-1" });
    expect(asked).toEqual(["question q2"]);
    expect(run.rows.filter((r) => r.queryId === "q2").map((r) => r.outcome)).toEqual(["success"]);
  }, 20000);

  it("F4: a resend for fewer questions keeps only the rows it asks for", async () => {
    files.set(RESULT, [row("q1"), row("q2"), row("q3")].map((r) => JSON.stringify(r)).join("\n"));
    const seen: string[] = [];
    const run = await runAnswerEvaluation({ questions: Q.slice(0, 2), models: [{ id: "qwen", label: "Qwen" }], resumeKey: "req-1", onRow: (r) => seen.push(r.queryId) });
    expect(asked).toEqual([]);
    expect(run.rows.map((r) => r.queryId)).toEqual(["q1", "q2"]);
    expect(seen).toEqual(["q1", "q2"]);
  }, 20000);
});
