import { describe, it, expect } from "vitest";
import { assembleChatMessages, assemblePrompt } from "../rag/pure";
import { formatPlacesAnswer } from "./geo";

// Models copy a literal "[n]" from the instructions into their answers
// (Qwen3-4B ended 82/96 eval answers with it), so no prompt may contain one.
describe("no literal [n] citation placeholder", () => {
  const src = [{ chunkId: "a", docId: "a", title: "Canberra", body: "Canberra is the capital.", score: 1, matchType: "hybrid" as const }];

  it("in the answer prompts, which show concrete numbers instead", () => {
    const texts = [
      assemblePrompt("q", src),
      ...assembleChatMessages("q", src).map((m) => m.content),
      assemblePrompt("q", []),
      ...assembleChatMessages("q", []).map((m) => m.content),
    ];
    for (const t of texts) expect(t).not.toContain("[n]");
    expect(assemblePrompt("q", src)).toContain("like [1] or [2]");
  });

  it("in the places answer text", () => {
    const text = formatPlacesAnswer({
      intent: { near: { kind: "device" }, diet: ["vegan"], wantsBest: true, lang: "en" },
      places: [{ id: "osm:node/1", name: "Tokyo Vegan", lat: 0, lon: 0, source: "osm", sourceIndex: 0, distanceM: 400 }],
      areaLabel: "near you",
      byDistance: true,
      osmDate: "2026-08",
    });
    expect(text).not.toContain("[n]");
  });
});
