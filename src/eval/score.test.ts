import { describe, it, expect } from "vitest";
import { median, scoreConfig, scoreParts, scoreRun } from "./score.pure";
import type { EvalResultRow } from "./evalHarness.pure";

const row = (over: Partial<EvalResultRow>): EvalResultRow =>
  ({
    runId: "r",
    evalSetVersion: "1",
    configId: "model:a",
    configLabel: "Model A",
    modelId: "a",
    queryId: "q",
    outcome: "success",
    timedOut: false,
    tokensGenerated: 100,
    tokPerSec: 10,
    ttftMs: 2000,
    totalLatencyMs: 12000,
    expectedKbHit: null,
    ...over,
  }) as EvalResultRow;

describe("median", () => {
  it("matches percentile_cont(0.5): the middle value, or the mean of the two middle ones", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});

describe("scoreParts", () => {
  it("weights speed 60%, reliability 25%, retrieval 15%", () => {
    expect(scoreParts(1, 1, 1)).toBe(100);
    expect(scoreParts(0.5, 1, 1)).toBe(70);
    expect(scoreParts(1, 1, 0)).toBe(85);
  });

  it("rescales speed and reliability when no question expected an article", () => {
    expect(scoreParts(1, 1, undefined)).toBe(100);
    expect(scoreParts(0.5, 1, undefined)).toBe(65);
  });

  it("is 0 below half the answers completed, however fast", () => {
    expect(scoreParts(1, 0.49, 1)).toBe(0);
    expect(scoreParts(1, 0.5, 1)).toBe(88);
  });
});

describe("scoreConfig", () => {
  it("measures speed only on completed answers of 16 tokens or more", () => {
    const s = scoreConfig([
      row({ tokPerSec: 10 }),
      row({ tokPerSec: 30 }),
      row({ tokPerSec: 99, tokensGenerated: 9 }),
      row({ tokPerSec: 99, outcome: "failure" }),
    ]);
    expect(s.medianTokPerSec).toBe(20);
    expect(s.speed).toBe(1);
    expect(s.reliability).toBe(0.75);
  });

  it("counts a timed-out answer as not completed", () => {
    expect(scoreConfig([row({}), row({ timedOut: true })]).completed).toBe(1);
  });

  it("scores retrieval only on questions that expect an article", () => {
    const s = scoreConfig([row({ expectedKbHit: true }), row({ expectedKbHit: false }), row({ expectedKbHit: null })]);
    expect([s.retrievalQuestions, s.retrievalHits, s.retrieval]).toEqual([2, 1, 0.5]);
  });

  it("keeps the raw metrics next to the score", () => {
    const s = scoreConfig([row({ ttftMs: 1000, peakRssBytes: 5 }), row({ ttftMs: 3000, peakRssBytes: 9 })]);
    expect(s).toMatchObject({ medianTtftMs: 2000, medianTotalMs: 12000, peakRssBytes: 9, modelLabel: "Model A" });
  });
});

describe("scoreRun", () => {
  it("scores each configuration and puts the best first", () => {
    const scores = scoreRun([row({ configId: "slow", tokPerSec: 4 }), row({ configId: "fast", tokPerSec: 20 })]);
    expect(scores.map((s) => s.configId)).toEqual(["fast", "slow"]);
  });
});
