import { describe, it, expect } from "vitest";
import { taskRequest } from "./format";

describe("taskRequest", () => {
  it("sends role messages (rendered by the GGUF's own template) when the model has one", () => {
    expect(taskRequest("Summarize.", "text", "Summary:", true)).toEqual({
      messages: [
        { role: "system", content: "Summarize." },
        { role: "user", content: "text" },
      ],
    });
  });

  it("falls back to a hand-built prompt with a cue only without a template", () => {
    expect(taskRequest("Summarize.", "text", "Summary:", false)).toEqual({ prompt: "Summarize.\n\ntext\n\nSummary:" });
  });
});
