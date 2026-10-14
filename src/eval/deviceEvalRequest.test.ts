import { describe, it, expect } from "vitest";
import { blockedEvalModels, matchModels, parseEvalRequest, resolveEvalRequest } from "./deviceEvalRequest.pure";
import { EVAL_SET, VITALIK_SET, setVersionOf } from "./evalSet";
import { MODEL_CATALOG, CatalogModel } from "../models/manifest";

const PHI = MODEL_CATALOG.find((m) => m.id === "phi-3.5-mini-instruct-q4km")!;
const QWEN = MODEL_CATALOG.find((m) => m.id === "qwen2.5-1.5b-instruct-q4km")!;
const QWEN_7B = MODEL_CATALOG.find((m) => m.id === "qwen2.5-7b-instruct-q4km")!;
const INSTELLA: CatalogModel = { ...PHI, id: "hf-amd-instella-moe-16b-a3b-q2_k", label: "Instella-MoE-16B-A3B Q2_K", filename: "models/instella.gguf", capabilities: undefined };
const installed = [PHI, QWEN, QWEN_7B, INSTELLA];

describe("parseEvalRequest", () => {
  it("accepts a well-formed request", () => {
    expect(parseEvalRequest('{"requestId":"req-1","models":["phi-3.5"],"adaptive":true,"queries":["greeting-1"]}')).toEqual({
      requestId: "req-1",
      models: ["phi-3.5"],
      adaptive: true,
      queries: ["greeting-1"],
    });
  });

  it("rejects bad ids and bad field types", () => {
    expect(() => parseEvalRequest('{"requestId":"../x"}')).toThrow(/requestId/);
    expect(() => parseEvalRequest('{"requestId":"r","models":"phi"}')).toThrow(/models/);
    expect(() => parseEvalRequest('{"requestId":"r","models":[""]}')).toThrow(/models/);
    expect(() => parseEvalRequest('{"requestId":"r","adaptive":"yes"}')).toThrow(/adaptive/);
    expect(() => parseEvalRequest("not json")).toThrow();
  });
});

describe("matchModels", () => {
  it("prefers an exact id, otherwise matches id or label fragments ignoring punctuation", () => {
    expect(matchModels(QWEN.id, installed)).toEqual([QWEN]);
    expect(matchModels("phi-3.5", installed)).toEqual([PHI]);
    expect(matchModels("qwen2.5-1.5b", installed)).toEqual([QWEN]);
    expect(matchModels("instella-moe", installed)).toEqual([INSTELLA]);
    expect(matchModels("qwen2.5", installed)).toEqual([QWEN, QWEN_7B]);
    expect(matchModels("llama", installed)).toEqual([]);
  });
});

describe("resolveEvalRequest", () => {
  const resolve = (req: object) => resolveEvalRequest({ requestId: "r", ...req }, installed, EVAL_SET, "Adaptive");

  it("defaults to every installed model plus adaptive, all queries", () => {
    const r = resolve({});
    expect(r.ok && r.configs.map((c) => (c.kind === "model" ? c.modelId : "adaptive"))).toEqual([PHI.id, QWEN.id, QWEN_7B.id, INSTELLA.id, "adaptive"]);
    expect(r.ok && r.queries).toHaveLength(EVAL_SET.length);
  });

  it("runs only what was selected", () => {
    const models = resolve({ models: ["qwen2.5-1.5b", "phi-3.5"] });
    expect(models.ok && models.configs.map((c) => c.label)).toEqual([QWEN.label, PHI.label]);
    const adaptive = resolve({ adaptive: true });
    expect(adaptive.ok && adaptive.configs.map((c) => c.kind)).toEqual(["adaptive"]);
    const both = resolve({ models: ["instella"], adaptive: true });
    expect(both.ok && both.configs.map((c) => c.kind)).toEqual(["model", "adaptive"]);
  });

  it("fails loudly on unknown or ambiguous model selectors", () => {
    expect(resolve({ models: ["llama"] })).toEqual({ ok: false, error: 'model "llama" matches no installed model' });
    const amb = resolve({ models: ["qwen2.5"] });
    expect(!amb.ok && amb.error).toMatch(/ambiguous.*qwen2\.5-1\.5b.*qwen2\.5-7b/);
  });

  it("filters queries by id or category, rejecting unknown ones", () => {
    const r = resolve({ queries: ["greeting-1", "reasoning"] });
    expect(r.ok && r.queries.map((q) => q.id)).toEqual(["greeting-1", "reasoning-1", "reasoning-2", "reasoning-3"]);
    expect(resolve({ queries: ["nope"] })).toEqual({ ok: false, error: "unknown query id or category: nope" });
  });

  it("runs the Vitalik battery only when asked for, never by default", () => {
    const all = (req: object) => resolveEvalRequest({ requestId: "r", ...req }, installed, EVAL_SET, "Adaptive", VITALIK_SET);
    const standard = all({});
    expect(standard.ok && standard.queries).toHaveLength(EVAL_SET.length);
    const battery = all({ queries: ["vitalik"] });
    expect(battery.ok && battery.queries).toHaveLength(VITALIK_SET.length);
    expect(battery.ok && battery.queries.every((q) => setVersionOf(q) === "vitalik-1")).toBe(true);
    const one = all({ queries: ["vitalik-about-x", "greeting-1"] });
    expect(one.ok && one.queries.map((q) => q.id)).toEqual(["greeting-1", "vitalik-about-x"]);
  });

  it("keeps the Vitalik battery's ids unique and apart from the standard set", () => {
    const ids = [...EVAL_SET, ...VITALIK_SET].map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EVAL_SET.some((q) => q.category === "vitalik")).toBe(false);
    expect(EVAL_SET.every((q) => setVersionOf(q) === "1")).toBe(true);
  });

  it("still runs adaptive when no model is installed, matching the Evaluation screen", () => {
    const r = resolveEvalRequest({ requestId: "r" }, [], EVAL_SET, "A");
    expect(r.ok && r.configs.map((c) => c.kind)).toEqual(["adaptive"]);
  });
});

describe("blockedEvalModels (F1: a requested model answer() would replace)", () => {
  const GiB = 1024 ** 3;
  const FOUR_B = { ...QWEN, id: "qwen3-4b", answerTier: "default" as const, sizeBytes: 2.5e9 };
  it("flags an unconfirmed big model on a low-RAM phone, and a model that crashed on load", () => {
    expect(blockedEvalModels([FOUR_B, QWEN], 3.8 * GiB, {})).toEqual([{ id: "qwen3-4b", reason: "low-ram" }]);
    expect(blockedEvalModels([QWEN], 3.8 * GiB, { loadCrashedIds: [QWEN.id] })).toEqual([{ id: QWEN.id, reason: "load-crashed" }]);
  });
  it("lets it run when confirmed (in the app or by the request), or on a phone with enough RAM", () => {
    expect(blockedEvalModels([FOUR_B], 3.8 * GiB, { largeModelConfirmedIds: ["qwen3-4b"] })).toEqual([]);
    expect(blockedEvalModels([FOUR_B], 3.8 * GiB, {}, true)).toEqual([]);
    expect(blockedEvalModels([FOUR_B], 7.5 * GiB, {})).toEqual([]);
  });
  it("parses confirmLargeModels only on the answer pipeline", () => {
    expect(parseEvalRequest(JSON.stringify({ requestId: "r1", pipeline: "answer", confirmLargeModels: true })).confirmLargeModels).toBe(true);
    expect(() => parseEvalRequest(JSON.stringify({ requestId: "r1", confirmLargeModels: true }))).toThrow(/pipeline/);
  });
});
