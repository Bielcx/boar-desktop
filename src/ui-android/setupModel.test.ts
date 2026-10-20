import { describe, expect, it } from "vitest";
import { answerModelToInstall, heavyForComputer, recommendedAnswerModel } from "./setupModel";

const GB = 1024 ** 3;
const big = { id: "qwen3-4b", answerTier: "default" as const };
const small = { id: "qwen2.5-1.5b", answerTier: "compact" as const };
const models = [big, small];

describe("recommendedAnswerModel", () => {
  it("recommends the 4B from an 8 GB computer (reads 7.4-7.8 GB)", () => {
    expect(recommendedAnswerModel(models, 15.8 * GB)).toBe(big);
    expect(recommendedAnswerModel(models, 7.4 * GB)).toBe(big);
  });

  it("recommends the 1.5B under 8 GB", () => {
    expect(recommendedAnswerModel(models, 5.9 * GB)).toBe(small);
    expect(recommendedAnswerModel(models, 3.8 * GB)).toBe(small);
  });

  it("recommends the 1.5B when the RAM couldn't be read", () => {
    expect(recommendedAnswerModel(models, 0)).toBe(small);
  });
});

describe("heavyForComputer", () => {
  it("flags the 4B under 8 GB, never the 1.5B", () => {
    expect(heavyForComputer(big, 5.9 * GB)).toBe(true);
    expect(heavyForComputer(big, 7.4 * GB)).toBe(false);
    expect(heavyForComputer(small, 3.8 * GB)).toBe(false);
  });

  it("doesn't warn when the RAM couldn't be read", () => {
    expect(heavyForComputer(big, 0)).toBe(false);
  });
});

describe("answerModelToInstall", () => {
  it("takes the user's pick over everything", () => {
    expect(answerModelToInstall(models, { [small.id]: true }, 10.7 * GB, big.id)).toBe(big);
  });

  it("keeps a model already on the phone instead of downloading another", () => {
    expect(answerModelToInstall(models, { [small.id]: true }, 10.7 * GB)).toBe(small);
  });

  it("falls back to the recommended one", () => {
    expect(answerModelToInstall(models, {}, 10.7 * GB)).toBe(big);
    expect(answerModelToInstall(models, {}, 5.9 * GB)).toBe(small);
  });
});
