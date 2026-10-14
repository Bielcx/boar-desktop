import { describe, it, expect } from "vitest";
import { EVAL_SET } from "./evalSet";
import type { EvalResultRow } from "./evalHarness.pure";
import { KILLED_ERROR, killedRows, savedRunIds, parseEvalRows, parseManifest, remainingWork, runState, type EvalRunManifest } from "./evalResume.pure";

const q = (id: string) => EVAL_SET.find((x) => x.id === id)!;
const queries = [q("greeting-1"), q("grounded-2")];
const manifest: EvalRunManifest = {
  runId: "eval-1",
  evalSetVersion: "1",
  configs: [
    { kind: "model", modelId: "a", label: "A" },
    { kind: "model", modelId: "b", label: "B" },
  ],
  queryIds: ["greeting-1", "grounded-2"],
  startedAt: 1,
};
const row = (configId: string, queryId: string): EvalResultRow =>
  ({ runId: "eval-1", configId, queryId, personalityId: "succinct", maxTokens: 512, outcome: "success" }) as EvalResultRow;

describe("evalResume", () => {
  it("lists what is left, in run order", () => {
    const left = remainingWork(manifest, [row("model:a", "greeting-1")], queries);
    expect(left.map((w) => `${w.config.label}/${w.query.id}`)).toEqual(["A/grounded-2", "B/greeting-1", "B/grounded-2"]);
  });

  it("fails the answer the app died on and the rest of that model, nothing else", () => {
    const m = { ...manifest, inFlight: { configId: "model:a", queryId: "grounded-2" } };
    const rows = killedRows(m, [row("model:a", "greeting-1")], queries, 42);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ configId: "model:a", queryId: "grounded-2", modelId: "a", outcome: "failure", errorMessage: KILLED_ERROR, answer: "", expectedKbHit: false, createdAt: 42, maxTokens: 512 });
  });

  it("fails nothing when the app died between answers", () => {
    const m = { ...manifest, inFlight: { configId: "model:a", queryId: "greeting-1" } };
    expect(killedRows(m, [row("model:a", "greeting-1")], queries)).toEqual([]);
    expect(killedRows(manifest, [], queries)).toEqual([]);
  });

  it("reads rows, skipping a torn last line and keeping one row per answer", () => {
    const a = JSON.stringify(row("model:a", "greeting-1"));
    const again = JSON.stringify({ ...row("model:a", "greeting-1"), outcome: "failure" });
    const rows = parseEvalRows(`${a}\n${again}\n{"configId":"model:a","que`);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failure");
    expect(parseEvalRows("")).toEqual([]);
  });

  it("reads a manifest or nothing, and lists runs newest first", () => {
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(parseManifest("{}")).toBeNull();
    expect(parseManifest("nope")).toBeNull();
    expect(savedRunIds(["eval-2026-01-02.run.json", "eval-2026-01-02.jsonl", "eval-2026-03-01.run.json.tmp", "eval-2026-01-02.run.json.tmp", "requests"])).toEqual([
      "eval-2026-03-01",
      "eval-2026-01-02",
    ]);
    expect(runState(manifest)).toBe("unfinished");
    expect(runState({ ...manifest, endedAt: 2 })).toBe("ended");
  });
});
