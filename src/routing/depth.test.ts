import { describe, it, expect } from "vitest";
import { DepthInput, DepthModel, deepAutoEligible, deepAutoIneligibility, measuredSpeeds, modelSpeedStats, planAnswer, resolveDeepModel, FAST_RETRIEVE_K, FAST_CONTEXT_TOKENS } from "./depth";

const GB = 1024 ** 3;
const qwen15: DepthModel = { id: "qwen1.5", label: "Qwen 1.5B", sizeBytes: 1 * GB, roles: ["fast"] };
const lfm8: DepthModel = { id: "lfm8", label: "LFM2.5 8B-A1B", sizeBytes: 5 * GB, roles: [] };
const qwen7: DepthModel = { id: "qwen7", label: "Qwen 7B", sizeBytes: 4.7 * GB, roles: ["reasoning", "verifier"], tokPerSec: 6 };
const moe30: DepthModel = { id: "qwen3-30b", label: "Qwen3 30B-A3B", sizeBytes: 11 * GB, roles: ["reasoning"], fit: "streaming", tokPerSec: 5.5 };

const base = (over: Partial<DepthInput> = {}): DepthInput => ({
  taskType: "chat",
  requestedTier: "auto",
  quickFirst: true,
  alwaysComplete: false,
  fastModel: qwen15,
  deepModel: null,
  verifiers: [],
  hasReusedSources: false,
  ...over,
});

describe("planAnswer respects the user's model", () => {
  it("answers every task type with the picked model, never a curated 'fast' one (review C1)", () => {
    for (const taskType of ["chat", "lookup", "summarize", "compare", "research"] as const) {
      const plan = planAnswer(base({ taskType, fastModel: lfm8 }));
      expect(plan.generation?.modelId).toBe("lfm8");
      expect(plan.generation?.tier).toBe("fast");
    }
  });

  it("reports no model instead of inventing one", () => {
    const plan = planAnswer(base({ fastModel: null }));
    expect(plan.generation).toBeNull();
    expect(plan.reasonCodes).toContain("generate:no-model");
  });
});

describe("planAnswer toggle matrix (answerQuickFirst / answerAlwaysComplete)", () => {
  it("on/off (default): instant may finish a lookup; other questions get a preview, the fast answer and a deep offer", () => {
    const lookup = planAnswer(base({ taskType: "lookup" }));
    expect(lookup.instant).toBe("may-finish");
    expect(lookup.generation?.tier).toBe("fast");
    const chat = planAnswer(base({ taskType: "chat" }));
    expect(chat.instant).toBe("preview");
    expect(chat.offerDeep).toBe(true);
  });

  it("on/on: instant is only a preview, then straight to the complete answer (no fast pass)", () => {
    const plan = planAnswer(base({ taskType: "lookup", alwaysComplete: true, deepModel: moe30 }));
    expect(plan.instant).toBe("preview");
    expect(plan.generation).toMatchObject({ tier: "deep", modelId: "qwen3-30b", mode: "single" });
    expect(plan.offerDeep).toBe(false);
  });

  it("off/on: no preview, complete answer", () => {
    const plan = planAnswer(base({ quickFirst: false, alwaysComplete: true }));
    expect(plan.instant).toBe("off");
    expect(plan.generation?.tier).toBe("deep");
  });

  it("off/off: no preview, always the picked model, deepening only on request", () => {
    const plan = planAnswer(base({ quickFirst: false, taskType: "lookup" }));
    expect(plan.instant).toBe("off");
    expect(plan.generation).toMatchObject({ tier: "fast", modelId: "qwen1.5" });
    expect(plan.offerDeep).toBe(true);
  });
});

describe("planAnswer deep tier", () => {
  it("uses the deep model in one pass over more context when one is usable", () => {
    const plan = planAnswer(base({ requestedTier: "deep", deepModel: moe30 }));
    // Deep-tier contract (ADR 0001): TTFT <= 15 s on a streaming MoE.
    expect(plan.generation).toMatchObject({ tier: "deep", modelId: "qwen3-30b", mode: "single", retrieveK: 6, contextTokens: 400, maxTokens: 200, thinking: false });
    expect(plan.instant).toBe("off");
  });

  it("falls back to multi-pass on the picked model when no deep model fits (research preset reachable on a default install)", () => {
    const plan = planAnswer(base({ requestedTier: "deep", deepModel: { ...moe30, fit: "thrashing" } }));
    expect(plan.generation).toMatchObject({ tier: "deep", modelId: "qwen1.5", mode: "multipass" });
  });

  it("verifies the complete answer with a distinct verifier (verification reachable)", () => {
    const plan = planAnswer(base({ alwaysComplete: true, deepModel: moe30, verifiers: [qwen7] }));
    expect(plan.verify).toEqual({ modelId: "qwen7" });
  });

  it("never lets a model verify its own answer", () => {
    const plan = planAnswer(base({ alwaysComplete: true, fastModel: qwen7, verifiers: [qwen7] }));
    expect(plan.verify).toBeNull();
    expect(plan.reasonCodes).toContain("verify:skipped-no-distinct-verifier");
  });

  it("reuses the deepened answer's sources instead of retrieving again", () => {
    const plan = planAnswer(base({ requestedTier: "deep", hasReusedSources: true, deepModel: moe30, verifiers: [qwen7] }));
    expect(plan.retrieve).toBe(false);
    expect(plan.verify).toEqual({ modelId: "qwen7" });
  });

  it("skips retrieval, instant and deep offers for greetings and calculations", () => {
    for (const taskType of ["greeting", "calculate"] as const) {
      const plan = planAnswer(base({ taskType }));
      expect(plan.retrieve).toBe(false);
      expect(plan.instant).toBe("off");
      expect(plan.offerDeep).toBe(false);
    }
  });
});

describe("resolveDeepModel", () => {
  it("picks the largest usable reasoning model other than the fast one", () => {
    expect(resolveDeepModel([qwen15, qwen7, moe30], "qwen1.5", undefined)?.id).toBe("qwen3-30b");
    expect(resolveDeepModel([qwen15, qwen7, moe30], "qwen3-30b", undefined)?.id).toBe("qwen7");
  });

  it("honors an explicit choice, including 'none'", () => {
    expect(resolveDeepModel([qwen15, lfm8, moe30], "qwen1.5", "lfm8")?.id).toBe("lfm8");
    expect(resolveDeepModel([qwen15, moe30], "qwen1.5", null)).toBeNull();
    expect(resolveDeepModel([qwen15], "qwen1.5", "missing")).toBeNull();
  });

  it("drops models that would not fit", () => {
    expect(resolveDeepModel([qwen15, { ...moe30, fit: "insufficient" }], "qwen1.5", undefined)).toBeNull();
  });
});

describe("rule D6: automatic deep model needs >= 5 tok/s measured", () => {
  it("never picks a model measured below 5 tok/s automatically (Qwen 7B at 2.7 timed out)", () => {
    const slow7 = { ...qwen7, tokPerSec: 2.7 };
    expect(resolveDeepModel([qwen15, slow7], "qwen1.5", undefined)).toBeNull();
    // ...so the complete answer falls back to multi-pass on the picked model.
    const plan = planAnswer(base({ requestedTier: "deep", deepModel: resolveDeepModel([qwen15, slow7], "qwen1.5", undefined) }));
    expect(plan.generation).toMatchObject({ modelId: "qwen1.5", mode: "multipass" });
  });

  it("does not pick a never-measured model automatically", () => {
    expect(resolveDeepModel([qwen15, { ...moe30, tokPerSec: undefined }], "qwen1.5", undefined)).toBeNull();
    expect(deepAutoIneligibility({ ...moe30, tokPerSec: undefined })).toBe("unmeasured");
  });

  it("still honors a deep model the user picked explicitly, whatever its speed", () => {
    expect(resolveDeepModel([qwen15, { ...qwen7, tokPerSec: 2.7 }], "qwen1.5", "qwen7")?.id).toBe("qwen7");
    expect(resolveDeepModel([qwen15, { ...moe30, tokPerSec: undefined }], "qwen1.5", "qwen3-30b")?.id).toBe("qwen3-30b");
  });

  it("picks the largest eligible model", () => {
    expect(resolveDeepModel([qwen15, qwen7, { ...moe30, tokPerSec: 4.9 }], "qwen1.5", undefined)?.id).toBe("qwen7");
  });
});

describe("measuredSpeeds", () => {
  it("takes the median of successful, long-enough generations, needing 2 samples", () => {
    const m = measuredSpeeds([
      { modelId: "a", tokPerSec: 4, tokensGenerated: 100, outcome: "success" },
      { modelId: "a", tokPerSec: 6, tokensGenerated: 100, outcome: "success" },
      { modelId: "a", tokPerSec: 50, tokensGenerated: 3, outcome: "success" }, // too short
      { modelId: "a", tokPerSec: 1, tokensGenerated: 100, outcome: "failure" }, // failed
      { modelId: "b", tokPerSec: 9, tokensGenerated: 100, outcome: "success" }, // one sample only
    ]);
    expect(m.get("a")).toBe(5);
    expect(m.has("b")).toBe(false);
  });
});

describe("modelSpeedStats / deepAutoEligible (shared with the model picker)", () => {
  it("reports median, samples and last date, deriving tok/s from latency when not recorded", () => {
    const st = modelSpeedStats([
      { modelId: "m", tokensGenerated: 100, generationLatencyMs: 10_000, outcome: "success", createdAt: 1 },
      { modelId: "m", tokPerSec: 14, tokensGenerated: 100, outcome: "success", createdAt: 5 },
      { modelId: "m", tokPerSec: 12, tokensGenerated: 100, outcome: "success", createdAt: 3 },
    ]).get("m")!;
    expect(st).toEqual({ medianTokPerSec: 12, samples: 3, lastAt: 5 });
  });

  it("is eligible only with >= 2 samples at >= 5 tok/s", () => {
    expect(deepAutoEligible(null)).toBe(false);
    expect(deepAutoEligible({ medianTokPerSec: 9, samples: 1 })).toBe(false);
    expect(deepAutoEligible({ medianTokPerSec: 4.9, samples: 6 })).toBe(false);
    expect(deepAutoEligible({ medianTokPerSec: 5, samples: 2 })).toBe(true);
  });
});

describe("deepAutoEligible on a low-RAM phone (CR-1)", () => {
  it("never automatic above the compact size at <= 4.5 GB, whatever the speed", () => {
    const fast = { samples: 5, medianTokPerSec: 20 } as any;
    expect(deepAutoEligible(fast)).toBe(true);
    expect(deepAutoEligible(fast, { model: { sizeBytes: 11e9 }, totalRamBytes: 3.8 * 1024 ** 3 })).toBe(false);
    expect(deepAutoEligible(fast, { model: { sizeBytes: 11e9 }, totalRamBytes: 12 * 1024 ** 3 })).toBe(true);
  });
});

describe("quick answers read only what the question needs", () => {
  it("a lookup gets 3 sources and 450 tokens, other questions 4 and 700", () => {
    expect(planAnswer(base({ taskType: "lookup" })).generation).toMatchObject({ tier: "fast", retrieveK: 3, contextTokens: 450 });
    expect(planAnswer(base({ taskType: "compare" })).generation).toMatchObject({ tier: "fast", retrieveK: 4, contextTokens: 700 });
    expect(planAnswer(base({ taskType: "research" })).generation).toMatchObject({ tier: "fast", retrieveK: 4, contextTokens: 700 });
  });

  it("Deep Research and 'Always full answer' keep the full budget per pass", () => {
    expect(planAnswer(base({ taskType: "lookup", requestedTier: "deep" })).generation).toMatchObject({ retrieveK: FAST_RETRIEVE_K, contextTokens: FAST_CONTEXT_TOKENS });
    expect(planAnswer(base({ taskType: "research", alwaysComplete: true })).generation).toMatchObject({ retrieveK: FAST_RETRIEVE_K, contextTokens: FAST_CONTEXT_TOKENS });
  });
});
