import { describe, it, expect } from "vitest";
import type { RetrievedChunk } from "../rag/retrieve.types";
import { answerPromptPrefix, assembleChatMessages, assemblePrompt, type ChatMessage } from "../rag/pure";
import { getPersonality } from "../constants/personalities";
import { approxTokens } from "./context";

/**
 * KV reuse of the system prompt. llama.rn keeps the previous completion's KV
 * cache and re-evaluates only from the first token that differs
 * (find_common_prefix_length, llama.rn cpp/rn-completion.cpp), so no app-side
 * state saving is needed: any prompt whose opening tokens repeat is reused
 * for free while the same model stays loaded. This test measures how much of
 * a follow-up question's prompt is that shared prefix with the app's layout.
 * (A layout with sources after the history was tried and reused only ~6%
 * more, because history stores the raw question, not the sources sent with
 * it, so it was not adopted.)
 */
const src = (id: string, title: string, body: string): RetrievedChunk => ({ chunkId: id, docId: id, title, body, score: 1, matchType: "hybrid" });
const serialize = (msgs: ChatMessage[]) => msgs.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join("");
const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
};

describe("system-prompt KV reuse across turns", () => {
  it("shares the whole system instruction between consecutive RAG questions", () => {
    const system = "You are a concise research assistant.";
    const t1 = serialize(
      assembleChatMessages("What is the capital of Australia?", [src("a", "Canberra", "Canberra is the capital city of Australia.")], system)
    );
    const t2 = serialize(
      assembleChatMessages(
        "Who designed it?",
        [src("b", "Walter Burley Griffin", "Walter Burley Griffin was an American architect who designed Canberra.")],
        system,
        { turns: [{ role: "user", text: "What is the capital of Australia?" }, { role: "assistant", text: "Canberra [1]." }] }
      )
    );
    const shared = commonPrefix(t1, t2);
    console.log(`[prompt] turn-2 prompt tokens reusable from KV: ${approxTokens(shared)} of ${approxTokens(t2)}`);
    // Everything up to the context block is identical, grounding instruction included.
    expect(shared).toContain("You have no ability to control real-world devices");
    expect(approxTokens(shared)).toBeGreaterThan(100);
  });
});

describe("answerPromptPrefix: the part of a question's prompt kept prefilled", () => {
  const succinct = getPersonality("succinct");
  // iPhone 13 telemetry (28/09): ~400-token prompts, 90-146 of them sources; "what's a monsoon?" with the Monsoon source.
  const monsoon = [
    src("m", "Monsoon", "A monsoon is traditionally a seasonal reversing wind accompanied by corresponding changes in precipitation, but now used to describe seasonal changes in atmospheric circulation and precipitation associated with annual latitudinal oscillation of the Intertropical Convergence Zone, specifically between its limits to the north and south of the equator."),
  ];

  it("opens both prompt builders' output for every tone, with sources", () => {
    for (const system of [succinct.systemPrompt, getPersonality("detailed").systemPrompt, "", undefined]) {
      const prefix = answerPromptPrefix(system);
      const msgs = assembleChatMessages("what's a monsoon?", monsoon, system, { summary: "Earlier: seasons.", turns: [{ role: "user", text: "hi" }] }, succinct.styleReminder);
      expect(msgs[0].content.startsWith(prefix.system)).toBe(true);
      expect(assemblePrompt("what's a monsoon?", monsoon, system, undefined, succinct.styleReminder).startsWith(prefix.prompt)).toBe(true);
    }
    // No sources: another system message (no source rules), so the engine refills the prefix after it.
    expect(assembleChatMessages("hi", [], succinct.systemPrompt)[0].content.startsWith(answerPromptPrefix(succinct.systemPrompt).system)).toBe(false);
  });

  it("leaves a first question only its sources and itself to prefill", () => {
    const prompt = serialize(assembleChatMessages("what's a monsoon?", monsoon, succinct.systemPrompt, undefined, succinct.styleReminder));
    const cached = `<|im_start|>system\n${answerPromptPrefix(succinct.systemPrompt).system}`;
    expect(prompt.startsWith(cached)).toBe(true);
    const total = approxTokens(prompt);
    const toPrefill = total - approxTokens(cached);
    console.log(`[prompt] first question of a new chat, tokens to prefill: before ${total}, after ${toPrefill} (prefix ${total - toPrefill} prefilled after load/title)`);
    // The prefix is more than half of a monsoon-sized prompt.
    expect(toPrefill).toBeLessThan(total / 2);
  });
});
