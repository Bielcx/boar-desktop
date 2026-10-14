import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
const { cleanForSpeech, speechAvailable } = await import("./speech");

describe("cleanForSpeech", () => {
  it("drops source marks and keeps the sentence", () => {
    expect(cleanForSpeech("Boil it for 3 minutes [1]. Then filter it [2, 3].")).toBe("Boil it for 3 minutes. Then filter it.");
  });

  it("drops markdown, code blocks and links", () => {
    const md = "## Steps\n- **Boil** the water\n- See [the manual](https://x.org/a)\n```js\nx()\n```\nDone `now`.";
    expect(cleanForSpeech(md)).toBe("Steps\nBoil the water\nSee the manual\nDone now.");
  });

  it("returns empty text for an answer that is only marks", () => {
    expect(cleanForSpeech(" [1] ")).toBe("");
  });
});

describe("speechAvailable", () => {
  it("is false on Android until a SpeechOutput module exists", () => {
    expect(speechAvailable()).toBe(false);
  });
});
