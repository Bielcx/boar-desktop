import { describe, expect, it } from "vitest";
import { approxWords, formatSeconds, receiptFromMeta } from "./receipt";

describe("answer receipt", () => {
  it("formats seconds under a minute and minutes above", () => {
    expect(formatSeconds(9_140)).toBe("9.1 s");
    expect(formatSeconds(125_000)).toBe("2 min 5 s");
  });

  it("counts about 0.75 words per token", () => {
    expect(approxWords(100)).toBe(75);
  });

  it("reads the receipt back from a message's meta, and nothing from older or broken meta", () => {
    const receipt = { totalMs: 1270, ttftMs: 332, tokPerSec: 29.5, tokens: 23, model: "Qwen2.5-1.5B" };
    expect(receiptFromMeta(JSON.stringify({ receipt }))).toEqual(receipt);
    expect(receiptFromMeta(null)).toBeNull();
    expect(receiptFromMeta("{")).toBeNull();
    expect(receiptFromMeta(JSON.stringify({ sources: [] }))).toBeNull();
  });
});
