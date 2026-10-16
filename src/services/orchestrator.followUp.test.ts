import { describe, it, expect, vi, beforeEach } from "vitest";

/** "conclusion" after a research answer was split as written, searched for "conclusion" and refused (native app, X6, Oct 13). */
const calls: { system: string; user: string; timeoutMs?: number }[] = [];
let reply: (system: string, user: string) => string = () => "ok";
let onCall: (system: string) => void = () => {};

vi.mock("../inference/LlamaEngine", () => ({
  llamaEngine: {
    hasEmbeddedChatTemplate: () => true,
    generate: async (opts: { messages: { role: string; content: string }[]; timeoutMs?: number }) => {
      const system = opts.messages.find((m) => m.role === "system")?.content ?? "";
      const user = opts.messages.find((m) => m.role === "user")?.content ?? "";
      calls.push({ system, user, timeoutMs: opts.timeoutMs });
      onCall(system);
      return reply(system, user);
    },
  },
}));

const searched: string[] = [];
vi.mock("../rag/retrieve", () => ({
  retrieve: async (q: string) => {
    searched.push(q);
    return [];
  },
}));

import { isMetaFollowUp, lastAnswered, lastExchange, parseSubQuestions, runDeepResearch } from "./orchestrator";

const history = {
  turns: [
    { role: "user" as const, text: "How does the greenhouse effect warm the planet?" },
    { role: "assistant" as const, text: "Gases like CO2 trap outgoing heat [1]." },
  ],
};

const NONE = { turns: [] as typeof history.turns };
const run = (q: string, h: typeof history | undefined = history, opts = {}, stop?: () => boolean) =>
  runDeepResearch(q, undefined, h === NONE ? undefined : h, 256, undefined, undefined, stop, opts);

beforeEach(() => {
  calls.length = 0;
  searched.length = 0;
  reply = () => "ok";
  onCall = () => {};
});

describe("Deep Research follow-ups", () => {
  it("rewrites a follow-up from the last exchange, then splits and synthesizes with it", async () => {
    reply = (system) =>
      system.startsWith("You rewrite")
        ? "What is the conclusion about how the greenhouse effect warms the planet?"
        : system.startsWith("You plan")
          ? "I'm sorry, but I can't help with that.\nWhat gases drive the greenhouse effect?\nHow much has the planet warmed?"
          : "ok";
    const r = await run("and its conclusion?");
    expect(calls[0].user).toContain("Previous question: How does the greenhouse effect");
    expect(calls[1].user).toContain("Question: What is the conclusion about how the greenhouse effect");
    expect(r.subQuestions).toEqual(["What gases drive the greenhouse effect?", "How much has the planet warmed?"]);
    expect(searched).toEqual(r.subQuestions);
    const synthesis = calls[calls.length - 1].user;
    expect(synthesis).toContain("Previous answer: Gases like CO2 trap outgoing heat [1].");
    expect(synthesis).toContain("Follow-up as asked: and its conclusion?");
  });

  it("does not rewrite a question that names its own subject", async () => {
    await run("How do Australian bushfires start?");
    expect(calls.some((c) => c.system.startsWith("You rewrite"))).toBe(false);
    expect(lastExchange("How do Australian bushfires start?", history)).toBeNull();
    expect(lastExchange("conclusion", undefined)).toBeNull();
  });

  it("keeps the follow-up as asked when the rewrite refuses", async () => {
    reply = (system) => (system.startsWith("You rewrite") ? "Sorry, I cannot do that." : "ok");
    await run("and the oceans?");
    expect(calls[1].user).toContain("Question: and the oceans?");
  });

  it("ends before the split when Stop comes during the rewrite", async () => {
    let stop = false;
    onCall = (system) => {
      if (system.startsWith("You rewrite")) stop = true;
    };
    reply = () => "What is the conclusion about the greenhouse effect?";
    const r = await run("and its conclusion?", history, {}, () => stop);
    expect(calls).toHaveLength(1);
    expect(r.subQuestions).toEqual([]);
  });

  it("gives the write-up no time limit, only the stages before it", async () => {
    reply = (system) => (system.startsWith("You plan") ? "Sub one about gases?\nSub two about heat?" : "ok");
    await run("How does the greenhouse effect warm the planet?", NONE);
    expect(calls.map((c) => c.timeoutMs)).toEqual([120_000, 120_000, 120_000, undefined]);
    expect(calls[calls.length - 1].system).toContain("never mention them, the sub-questions or the research steps");
  });

  it("skips a stopped question with no answer for the one before it", () => {
    const h = { turns: [...history.turns, { role: "user" as const, text: "conclusion" }] };
    expect(lastAnswered(h)?.question).toBe("How does the greenhouse effect warm the planet?");
  });

  it("builds a second continue on the first one's answer", () => {
    const h = {
      turns: [...history.turns, { role: "user" as const, text: "continue" }, { role: "assistant" as const, text: "More on trapped heat [2]." }],
    };
    expect(lastAnswered(h)).toEqual({ question: "continue", answer: "More on trapped heat [2]." });
  });

  it("recognizes meta follow-ups, not questions with a subject of their own", () => {
    for (const q of ["summary", "Conclusion", "TL;DR", "tldr", "continue", "go on", "tell me more", "a brief summary please",
      "a executive summary please", "sum it up", "resuma", "um resumo por favor", "continua"])
      expect(isMetaFollowUp(q), q).toBe(true);
    for (const q of ["summary of the causes of war", "What is the conclusion of the Treaty of Versailles?", "continue the history of Rome",
      "How does the greenhouse effect warm the planet?", "more about volcanoes", ""])
      expect(isMetaFollowUp(q), q).toBe(false);
  });

  it("writes a meta follow-up from the full previous answer, with no splitting or search", async () => {
    reply = () => "In short: CO2 traps heat [1].";
    const full = "Gases like CO2 trap outgoing heat [1]. Oceans absorb most of the excess [2].";
    const r = await run("TL;DR", history, { previousAnswer: full });
    expect(calls).toHaveLength(1);
    expect(searched).toHaveLength(0);
    expect(r.fromPreviousAnswer).toBe(true);
    expect(r.subQuestions).toEqual([]);
    expect(r.answer).toBe("In short: CO2 traps heat [1].");
    expect(calls[0].system).toContain("keep its source numbers exactly as written");
    expect(calls[0].user).toContain("Previous question: How does the greenhouse effect warm the planet?");
    expect(calls[0].user).toContain("Oceans absorb most of the excess [2].");
    expect(calls[0].user.endsWith("Follow-up: TL;DR")).toBe(true);
  });

  it("researches a meta follow-up as usual when there is no previous answer", async () => {
    const r = await run("summary", NONE);
    expect(r.fromPreviousAnswer).toBeFalsy();
    expect(calls[0].system.startsWith("You plan")).toBe(true);
  });

  it("drops refusal lines from the sub-questions", () => {
    expect(parseSubQuestions("Desculpe, não posso ajudar com isso.\nI cannot answer that question", "q")).toEqual(["q"]);
  });
});
