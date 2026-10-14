import { describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system/legacy", () => ({}));
const { packsToNextStage, stageFor, STAGES } = await import("./growth");
const { moodFor } = await import("./mood");

describe("growth", () => {
  it("starts as a piglet and grows with the packs", () => {
    expect(stageFor(0)).toBe("filhote");
    expect(stageFor(1)).toBe("jovem");
    expect(stageFor(3)).toBe("adulto");
    expect(stageFor(50)).toBe("anciao");
  });

  it("stages are in order, so each threshold is reachable", () => {
    for (let i = 1; i < STAGES.length; i++) expect(STAGES[i].minPacks).toBeGreaterThan(STAGES[i - 1].minPacks);
  });

  it("says how many packs the next stage needs", () => {
    expect(packsToNextStage(1)).toBe(2);
    expect(packsToNextStage(6)).toBeNull();
  });
});

describe("mood", () => {
  const base = { listening: false, speaking: false, processing: null, lastAnswerHadNoSource: false } as const;

  it("is idle with nothing going on", () => {
    expect(moodFor(base)).toBe("idle");
  });

  it("follows the answer's progress", () => {
    expect(moodFor({ ...base, processing: "retrieving" })).toBe("searching");
    expect(moodFor({ ...base, processing: "thinking" })).toBe("thinking");
    expect(moodFor({ ...base, processing: "generating" })).toBe("answering");
  });

  it("listening wins over everything, a new answer wins over reading the old one aloud", () => {
    expect(moodFor({ ...base, listening: true, processing: "generating", speaking: true })).toBe("listening");
    expect(moodFor({ ...base, speaking: true, processing: "retrieving" })).toBe("searching");
    expect(moodFor({ ...base, speaking: true, lastAnswerHadNoSource: true })).toBe("speaking");
  });

  it("looks down when the last answer found no source", () => {
    expect(moodFor({ ...base, lastAnswerHadNoSource: true })).toBe("notfound");
  });
});
