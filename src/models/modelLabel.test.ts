import { describe, expect, it } from "vitest";
import { shortModelLabel } from "./modelLabel";

describe("shortModelLabel", () => {
  it("drops the parenthesized details", () => {
    expect(shortModelLabel("Qwen2.5-1.5B-Instruct (Q4_K_M)")).toBe("Qwen2.5-1.5B-Instruct");
    expect(shortModelLabel("Gemma 3 (1B) (Q4_0)")).toBe("Gemma 3");
    expect(shortModelLabel("Phi (mini) 4")).toBe("Phi 4");
  });

  it("keeps a label with nothing to drop, or nothing left", () => {
    expect(shortModelLabel("LFM2.5-1.2B")).toBe("LFM2.5-1.2B");
    expect(shortModelLabel("(custom)")).toBe("(custom)");
  });
});
