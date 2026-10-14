import { describe, expect, it } from "vitest";
import type { AnswerEvent, AnswerReceipt } from "../routing/events";
import { answerTextOf, buildAnswerEvalRow, parseQuestions, TimedEvent } from "./answerEval.pure";
import { parseEvalRequest, resolveAnswerRequest } from "./deviceEvalRequest.pure";

const receipt: AnswerReceipt = { modelId: "qwen", modelLabel: "Qwen", tokens: 40, tokPerSec: 15, ttftMs: 2300, totalMs: 5100, reasonCodes: ["route:fast"] };
const meta = {
  runId: "eval-x",
  evalSetVersion: "dataset-v2",
  configId: "answer:current",
  configLabel: "current model",
  personalityId: "succinct",
  maxTokens: 512,
  answeredAnyway: false,
  createdAt: 1,
};
const ev = (atMs: number, event: AnswerEvent): TimedEvent => ({ atMs, event });
const q = { id: "cry-001", query: "Which signature schemes are quantum resistant?", category: "crypto-expert" };

describe("buildAnswerEvalRow", () => {
  it("records stage marks, first sources/token and the receipt", () => {
    const events = [
      ev(10, { type: "stage", answerId: "a", stage: "retrieving", tier: "fast", at: 0 }),
      ev(80, { type: "sources", answerId: "a", tier: "fast", sources: [{ title: "SPHINCS+" }, { title: "Lattice" }] as any }),
      ev(90, { type: "stage", answerId: "a", stage: "prefill", tier: "fast", at: 0 }),
      ev(2300, { type: "token", answerId: "a", tier: "fast", text: "SPHINCS+ " }),
      ev(2400, { type: "token", answerId: "a", tier: "fast", text: "is hash-based [1]." }),
      ev(5100, { type: "done", answerId: "a", tier: "fast", outcome: "success", receipt, cited: [1] }),
    ];
    const row = buildAnswerEvalRow(q, events, null, 5200, meta);
    expect(row.stages.map((s) => s.stage)).toEqual(["retrieving", "prefill"]);
    expect(row.firstSourcesMs).toBe(80);
    expect(row.firstTokenMs).toBe(2300);
    expect(row.ttftMs).toBe(2300);
    expect(row.totalLatencyMs).toBe(5100);
    expect(row.answer).toBe("SPHINCS+ is hash-based [1].");
    expect(row.citedTitles).toEqual(["SPHINCS+"]);
    expect(row.retrievedTitles).toEqual(["SPHINCS+", "Lattice"]);
    expect(row.outcome).toBe("success");
    expect(row.category).toBe("crypto-expert");
  });

  it("uses finalText over streamed tokens and flags a declined answer", () => {
    const events = [
      ev(50, { type: "warning", answerId: "a", code: "weak_sources", message: "weak", declined: true }),
      ev(60, { type: "done", answerId: "a", tier: "fast", outcome: "success", receipt: { ...receipt, tokens: 0 }, finalText: "" }),
    ];
    const row = buildAnswerEvalRow(q, events, null, 70, meta);
    expect(row.declined).toBe(true);
    expect(row.warnings).toEqual(["weak_sources"]);
    expect(row.answer).toBe("");
  });

  it("lists places in the answer text so venue scoring can read them", () => {
    const events = [
      ev(20, {
        type: "places",
        answerId: "a",
        tier: "instant",
        places: [{ id: "osm:node/1", name: "Brammibal's Donuts", lat: 0, lon: 0, source: "osm", address: "Maybachufer 8" }],
        area: { kind: "city", label: "Berlin" },
        criterion: "diet_match",
        coverage: "ok",
        attribution: [],
      }),
      ev(30, { type: "done", answerId: "a", tier: "instant", outcome: "success", receipt: { ...receipt, modelId: "places" } }),
    ];
    const row = buildAnswerEvalRow({ id: "food-001", query: "vegan in Berlin", category: "local-food" }, events, null, 40, meta);
    expect(row.places).toEqual({ count: 1, coverage: "ok", empty: undefined, areaKind: "city" });
    expect(row.placesMs).toBe(20);
    expect(answerTextOf(null, events)).toBe("- Brammibal's Donuts (Maybachufer 8)");
  });

  it("marks a runner error as a failure", () => {
    const row = buildAnswerEvalRow(q, [], null, 240000, meta, "timeout after 240 s");
    expect(row.outcome).toBe("failure");
    expect(row.errorMessage).toBe("timeout after 240 s");
    expect(row.totalLatencyMs).toBe(240000);
  });
});

describe("answer pipeline requests", () => {
  it("parses questions and the answer-only flags", () => {
    const r = parseEvalRequest(
      JSON.stringify({ requestId: "req-1", pipeline: "answer", answerAnyway: true, evalSetVersion: "dataset-v2", questions: [q] })
    );
    expect(r.pipeline).toBe("answer");
    expect(r.questions).toEqual([q]);
    expect(r.answerAnyway).toBe(true);
  });

  it("rejects answer-only fields on the legacy pipeline, duplicate ids and a bad pipeline", () => {
    expect(() => parseEvalRequest(JSON.stringify({ requestId: "req-1", questions: [q] }))).toThrow(/pipeline/);
    expect(() => parseQuestions([q, q])).toThrow(/unique/);
    // Ids that only differ by surrounding spaces are the same id once trimmed (CodeRabbit, #36).
    expect(() => parseQuestions([{ ...q, id: "a" }, { ...q, id: "a " }])).toThrow(/unique/);
    expect(parseQuestions([{ ...q, id: " b " }])?.[0].id).toBe("b");
    expect(() => parseEvalRequest(JSON.stringify({ requestId: "req-1", pipeline: "fast" }))).toThrow(/pipeline/);
  });

  it("resolves models strictly and filters questions by category", () => {
    const installed = [{ id: "qwen2.5-1.5b", label: "Qwen2.5 1.5B" }, { id: "qwen3-4b", label: "Qwen3 4B" }] as any;
    const request = parseEvalRequest(
      JSON.stringify({ requestId: "req-2", pipeline: "answer", models: ["1.5b"], queries: ["crypto-expert"], questions: [q, { id: "food-1", query: "vegan", category: "local-food" }] })
    );
    const r = resolveAnswerRequest(request, installed, []);
    expect(r).toEqual({ ok: true, models: [{ id: "qwen2.5-1.5b", label: "Qwen2.5 1.5B" }], questions: [q] });
    const bad = resolveAnswerRequest({ ...request, models: ["qwen"] }, installed, []);
    expect(bad.ok).toBe(false);
  });

  it("parses install and answerSettings, and rejects bad ones", () => {
    const r = parseEvalRequest(
      JSON.stringify({ requestId: "req-3", pipeline: "answer", install: { places: ["Berlin"], assets: ["boar-crypto"] }, answerSettings: { alwaysComplete: false } })
    );
    expect(r.install).toEqual({ places: ["Berlin"], assets: ["boar-crypto"] });
    expect(r.answerSettings).toEqual({ quickFirst: undefined, alwaysComplete: false });
    expect(() => parseEvalRequest(JSON.stringify({ requestId: "req-3", install: { places: ["Berlin"] } }))).toThrow(/pipeline/);
    expect(() => parseEvalRequest(JSON.stringify({ requestId: "req-3", pipeline: "answer", answerSettings: { deep: true } }))).toThrow(/answerSettings/);
  });
});
