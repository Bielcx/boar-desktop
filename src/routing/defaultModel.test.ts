import { describe, it, expect } from "vitest";
import { AUTO_PICK_MAX_MODEL_BYTES, isCompactModel, LOW_RAM_MAX_MODEL_BYTES, pickDefaultAnswerModel, rankAnswerModels, tooBigForAutoPick, tooBigForLowRam } from "./defaultModel";
import { contextSizeForRam, estimateMemoryFit, parseGgufShape, toGb } from "../inference/memoryFit";

const GiB = 1024 ** 3;
// Header of Qwen3-4B-Instruct-2507 Q4_K_M (unsloth, read on the Mac mini).
const QWEN3_4B = parseGgufShape({
  "general.architecture": "qwen3",
  "qwen3.block_count": "36",
  "qwen3.embedding_length": "2560",
  "qwen3.feed_forward_length": "9728",
  "qwen3.attention.head_count": "32",
  "qwen3.attention.head_count_kv": "8",
  "qwen3.attention.key_length": "128",
  "qwen3.attention.value_length": "128",
  "qwen3.vocab_size": "151936",
});
const FILE_4B = 2497281120;

describe("Qwen3-4B memory fit by device (header-based)", () => {
  // availableRamBytes: iOS os_proc_available_memory / Android MemAvailable with the app in front.
  const devices = [
    { name: "iPhone 13, 4 GB", total: 3.7 * GiB, avail: 2.0 * GiB, expect: "thrashing" },
    { name: "Android 6 GB, busy", total: 5.6 * GiB, avail: 3.0 * GiB, expect: "thrashing" },
    { name: "Android 6 GB, light", total: 5.6 * GiB, avail: 3.6 * GiB, expect: "resident" },
    { name: "Android 8 GB", total: 7.5 * GiB, avail: 4.5 * GiB, expect: "resident" },
    { name: "Pixel 12 GB", total: 11.5 * GiB, avail: 7.0 * GiB, expect: "resident" },
  ] as const;

  for (const d of devices) {
    it(`${d.name}: n_ctx ${contextSizeForRam(d.total)} -> ${d.expect}`, () => {
      const nCtx = contextSizeForRam(d.total);
      const fit = estimateMemoryFit({ fileBytes: FILE_4B, nCtx, shape: QWEN3_4B, totalRamBytes: d.total, availableRamBytes: d.avail });
      console.log(`[4B] ${d.name}: ctx ${nCtx}, KV ${toGb(fit.kvCacheBytes)} GB, buffers ${toGb(fit.anonBytes)} GB + weights ${toGb(FILE_4B)} GB vs ${toGb(d.avail)} GB -> ${fit.verdict}`);
      expect(fit.verdict).toBe(d.expect);
      // The KV cache and buffers alone always fit: the 4B never refuses to load, it may only be slow.
      expect(fit.verdict).not.toBe("insufficient");
    });
  }

  it("KV cache is 144 KiB per token (36 layers x 8 KV heads x 256 x 2 bytes)", () => {
    const fit = estimateMemoryFit({ fileBytes: FILE_4B, nCtx: 4096, shape: QWEN3_4B, totalRamBytes: 12 * GiB, availableRamBytes: 8 * GiB });
    expect(fit.kvCacheBytes).toBe(4096 * 36 * 8 * 256 * 2);
  });
});

describe("contextSizeForRam", () => {
  it("2048 up to 4.5 GB, 3072 up to 6.5 GB, 4096 above or unknown", () => {
    expect(contextSizeForRam(3.7 * GiB)).toBe(2048);
    expect(contextSizeForRam(5.6 * GiB)).toBe(3072);
    expect(contextSizeForRam(7.5 * GiB)).toBe(4096);
    expect(contextSizeForRam(0)).toBe(4096);
  });
});

describe("pickDefaultAnswerModel", () => {
  const both = (fit4b?: "resident" | "thrashing") => [
    { id: "qwen3-4b", answerTier: "default" as const, fit: fit4b },
    { id: "qwen2.5-1.5b", answerTier: "compact" as const },
  ];

  it("gives the 4B to devices where it stays resident", () => {
    expect(pickDefaultAnswerModel(both("resident"), 7.5 * GiB)).toEqual({ id: "qwen3-4b", reason: "default-tier" });
  });

  it("gives 4 GB phones the compact model, whatever the fit says", () => {
    expect(pickDefaultAnswerModel(both("resident"), 3.7 * GiB)).toEqual({ id: "qwen2.5-1.5b", reason: "compact-low-ram" });
  });

  it("falls back to compact when the 4B would re-read its weights every token", () => {
    expect(pickDefaultAnswerModel(both("thrashing"), 5.6 * GiB)).toEqual({ id: "qwen2.5-1.5b", reason: "compact-does-not-fit" });
  });

  it("uses what is installed when only one tier is", () => {
    // CR-1: never the 4B on a 4 GB phone, not even as the only model.
    expect(pickDefaultAnswerModel([{ id: "qwen3-4b", answerTier: "default", fit: "thrashing" }], 3.7 * GiB)).toBeNull();
    expect(pickDefaultAnswerModel([{ id: "qwen3-4b", answerTier: "default", fit: "thrashing" }], 5.6 * GiB)?.id).toBe("qwen3-4b");
    expect(pickDefaultAnswerModel([{ id: "x" }], 8 * GiB)).toEqual({ id: "x", reason: "smallest-fallback" });
    expect(pickDefaultAnswerModel([], 8 * GiB)).toBeNull();
  });
});

describe("rankAnswerModels", () => {
  const GB = 1e9;
  const q4 = { id: "qwen3-4b", answerTier: "default" as const, sizeBytes: 2.5 * GB, fit: "resident" as const };
  const q15 = { id: "qwen2.5-1.5b", answerTier: "compact" as const, sizeBytes: 1.1 * GB };
  const lfm = { id: "lfm2.5-8b-a1b", sizeBytes: 4.8 * GB, fit: "resident" as const };
  const gemma = { id: "gemma-1b", sizeBytes: 0.8 * GB };

  it("ranks every installed model once, pick first, with a stable reason", () => {
    const r = rankAnswerModels([gemma, lfm, q15, q4], 7.5 * GiB);
    expect(r.pick).toEqual({ id: "qwen3-4b", reason: "default-tier" });
    expect(r.ranked).toEqual([
      { id: "qwen3-4b", picked: true, reason: "default-tier" },
      { id: "qwen2.5-1.5b", picked: false, reason: "outranked" },
      { id: "lfm2.5-8b-a1b", picked: false, reason: "unmeasured" },
      { id: "gemma-1b", picked: false, reason: "unmeasured" },
    ]);
  });

  it("passes over the 4B when it was measured under 6 tok/s on this phone", () => {
    const r = rankAnswerModels([{ ...q4, tokPerSec: 4.1 }, q15], 7.5 * GiB);
    expect(r.pick).toEqual({ id: "qwen2.5-1.5b", reason: "compact-default-too-slow" });
    expect(r.ranked[1]).toEqual({ id: "qwen3-4b", picked: false, reason: "too-slow" });
  });

  it("an unmeasured 4B still wins: no measurement is not a slow measurement", () => {
    expect(rankAnswerModels([q4, q15], 7.5 * GiB).pick?.id).toBe("qwen3-4b");
  });

  it("explains the 4B on a 4 GB phone as low RAM", () => {
    const r = rankAnswerModels([q4, q15], 3.7 * GiB);
    expect(r.pick).toEqual({ id: "qwen2.5-1.5b", reason: "compact-low-ram" });
    expect(r.ranked[1]).toEqual({ id: "qwen3-4b", picked: false, reason: "low-ram" });
  });

  it("takes the largest fast model when neither tier can answer well", () => {
    const r = rankAnswerModels([{ ...q4, tokPerSec: 3 }, { ...q15, tokPerSec: 5 }, { ...lfm, tokPerSec: 14 }, { ...gemma, tokPerSec: 30 }], 7.5 * GiB);
    expect(r.pick).toEqual({ id: "lfm2.5-8b-a1b", reason: "largest-fast" });
    expect(r.ranked.map((x) => x.reason)).toEqual(["largest-fast", "too-slow", "too-slow", "outranked"]);
  });

  it("falls back to the smallest model that fits", () => {
    const r = rankAnswerModels([{ ...lfm, fit: "thrashing" }, gemma, { id: "big", sizeBytes: 3 * GB }], 7.5 * GiB);
    expect(r.pick).toEqual({ id: "gemma-1b", reason: "smallest-fallback" });
    expect(r.ranked.find((x) => x.id === "lfm2.5-8b-a1b")?.reason).toBe("wont-fit");
  });

  it("accepts candidates with no fit, size or speed (boot, before any measurement)", () => {
    expect(rankAnswerModels([{ id: "a" }, { id: "b" }], 0).pick).toEqual({ id: "a", reason: "smallest-fallback" });
    expect(rankAnswerModels([], 0)).toEqual({ pick: null, ranked: [] });
  });
});

describe("CR-1: nothing above the compact model on a low-RAM phone", () => {
  const GB = 1e9;
  it("no automatic pick bigger than the compact size at <= 4.5 GB, even a fast one", () => {
    const r = rankAnswerModels(
      [
        { id: "qwen3-4b", answerTier: "default", sizeBytes: 2.5 * GB },
        { id: "lfm", sizeBytes: 4.8 * GB, tokPerSec: 14, fit: "resident" },
      ],
      3.8 * GiB
    );
    expect(r.pick).toBeNull();
    expect(r.ranked.map((x) => x.reason)).toEqual(["low-ram", "low-ram"]);
  });

  it("small untiered models are still fine", () => {
    expect(rankAnswerModels([{ id: "gemma-1b", sizeBytes: 0.8 * GB }], 3.8 * GiB).pick).toEqual({ id: "gemma-1b", reason: "smallest-fallback" });
    expect(tooBigForLowRam({ sizeBytes: 0.8 * GB }, 3.8 * GiB)).toBe(false);
    expect(tooBigForLowRam({ answerTier: "compact", sizeBytes: 1.1 * GB }, 3.8 * GiB)).toBe(false);
    expect(tooBigForLowRam({ answerTier: "default", sizeBytes: 2.5 * GB }, 7.5 * GiB)).toBe(false);
  });

  it("never auto-picks a ~1.5 GB untiered model on a 4 GB phone (0.35 tok/s on iPhone 13)", () => {
    expect(AUTO_PICK_MAX_MODEL_BYTES).toBe(1.1e9);
    // MiniCPM5-2B / LFM2.5-2.6B Q4_0 are ~1.5 GB: not auto-picked on 3.8 GiB, fine on 7.5 GiB.
    expect(tooBigForAutoPick({ sizeBytes: 1.5 * GB }, 3.8 * GiB)).toBe(true);
    expect(tooBigForAutoPick({ sizeBytes: 1.5 * GB }, 7.5 * GiB)).toBe(false);
    // The compact Qwen2.5-1.5B (0.99 GB) and a 1.2B (0.73 GB) are still under the cap.
    expect(tooBigForAutoPick({ sizeBytes: 0.99 * GB }, 3.8 * GiB)).toBe(false);
    expect(tooBigForAutoPick({ sizeBytes: 0.73 * GB }, 3.8 * GiB)).toBe(false);
    const fast = (id: string, sizeBytes: number) => ({ id, sizeBytes, tokPerSec: 20, fit: "resident" as const });
    expect(rankAnswerModels([fast("minicpm5-2b", 1.5 * GB)], 3.8 * GiB).pick).toBeNull();
    const r = rankAnswerModels([fast("minicpm5-2b", 1.5 * GB), fast("lfm2.5-1.2b", 0.73 * GB)], 3.8 * GiB);
    expect(r.pick?.id).toBe("lfm2.5-1.2b");
    expect(r.ranked.find((m) => m.id === "minicpm5-2b")?.reason).toBe("low-ram");
  });

  it("a model the user chose keeps the 1.6e9 cap: only the automatic pick uses the lower one", () => {
    expect(LOW_RAM_MAX_MODEL_BYTES).toBe(1.6e9);
    expect(tooBigForLowRam({ sizeBytes: 1.3 * GB }, 3.8 * GiB)).toBe(false);
    expect(tooBigForAutoPick({ sizeBytes: 1.3 * GB }, 3.8 * GiB)).toBe(true);
    expect(isCompactModel({ sizeBytes: 1.5 * GB })).toBe(true);
    expect(isCompactModel({ sizeBytes: 2.4 * GB })).toBe(false);
  });
});
