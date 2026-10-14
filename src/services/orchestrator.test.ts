import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RetrievedChunk } from "../rag/retrieve.types";

const chunk = (id: string, title: string, body: string): RetrievedChunk => ({
  chunkId: id,
  docId: id,
  title,
  body,
  score: 1,
  matchType: "hybrid",
});
const FR = chunk("fr", "French Revolution", "The French Revolution began in 1789 with a financial crisis in France.");
const IR = chunk("ir", "Industrial Revolution", "The Industrial Revolution began in Britain around 1760 with textile machines.");
const EU = chunk("eu", "Europe", "In Europe, the French Revolution and the Industrial Revolution were both caused by deep economic change.");

const calls: { messages?: { role: string; content: string }[]; prompt?: string }[] = [];
let hasTemplate = true;

vi.mock("../inference/LlamaEngine", () => ({
  llamaEngine: {
    hasEmbeddedChatTemplate: () => hasTemplate,
    generate: async (opts: { messages?: { role: string; content: string }[]; prompt?: string; onToken?: (p: string) => void }) => {
      calls.push(opts);
      const text = opts.messages?.map((m) => m.content).join("\n") ?? opts.prompt ?? "";
      if (text.includes("Break this research question")) return "What caused the French Revolution?\nWhat caused the Industrial Revolution?";
      opts.onToken?.("ok");
      return "ok [1]";
    },
  },
}));

const OFF = chunk("off", "Dean Lee", "Dean Lee is an American nuclear theorist who works on quantum computing algorithms.");
let withOffTopic = false;
/** When set, every sub-question retrieves these (a sub-question that adds no new source). */
let sameForAll: RetrievedChunk[] | null = null;
vi.mock("../rag/retrieve", () => ({
  retrieve: async (q: string) => sameForAll ?? [...(q.includes("French") ? [FR, EU] : [EU, IR]), ...(withOffTopic ? [OFF] : [])],
}));

import { runDeepResearch } from "./orchestrator";

beforeEach(() => {
  calls.length = 0;
  hasTemplate = true;
  withOffTopic = false;
  sameForAll = null;
});

const text = (c: (typeof calls)[number]) => c.messages?.map((m) => m.content).join("\n") ?? c.prompt ?? "";

describe("runDeepResearch citations", () => {
  it("numbers sources globally and deduplicates chunks shared by sub-questions", async () => {
    let emitted: RetrievedChunk[] = [];
    const r = await runDeepResearch("Compare the causes of both revolutions", undefined, undefined, 256, undefined, undefined, undefined, {
      onSources: (s) => (emitted = s),
    });
    const ids = r.citations.map((c) => c.chunkId);
    // Every source once, even though both sub-questions retrieved "Europe".
    expect([...ids].sort()).toEqual(["eu", "fr", "ir"]);
    expect(emitted).toEqual(r.citations);
    // "Europe" carries the same global number in both sub-question prompts, matching citations[n-1].
    const euNumber = ids.indexOf("eu") + 1;
    const first = text(calls[1]);
    const second = text(calls[2]);
    expect(first).toContain(`[${euNumber}] Europe`);
    expect(second).toContain(`[${euNumber}] Europe`);
    expect(second).toContain(`[${ids.indexOf("ir") + 1}] Industrial Revolution`);
  });

  it("an off-topic source is not read, numbered or shown (onTopic per sub-question)", async () => {
    withOffTopic = true;
    let emitted: RetrievedChunk[] = [];
    const r = await runDeepResearch("Compare the causes of both revolutions", undefined, undefined, 256, undefined, undefined, undefined, {
      onSources: (s) => (emitted = s),
    });
    expect(r.citations.map((c) => c.chunkId).sort()).toEqual(["eu", "fr", "ir"]);
    expect(emitted.map((c) => c.title)).not.toContain("Dean Lee");
    expect(calls.map(text).join("\n")).not.toContain("Dean Lee");
  });

  it("a PT question too (Quill 014c054): the off-topic source is not shown", async () => {
    withOffTopic = true;
    let emitted: RetrievedChunk[] = [];
    await runDeepResearch("Compare as causas das duas revoluções", undefined, undefined, 256, undefined, undefined, undefined, {
      onSources: (s) => (emitted = s),
    });
    expect(emitted.map((c) => c.title)).not.toContain("Dean Lee");
    expect(emitted.map((c) => c.chunkId).sort()).toEqual(["eu", "fr", "ir"]);
  });

  it("uses the model's chat template when the GGUF ships one, plain prompts otherwise", async () => {
    await runDeepResearch("Compare the causes of both revolutions", undefined, undefined, 256);
    expect(calls.every((c) => Array.isArray(c.messages) && c.prompt === undefined)).toBe(true);
    calls.length = 0;
    hasTemplate = false;
    await runDeepResearch("Compare the causes of both revolutions", undefined, undefined, 256);
    expect(calls.every((c) => typeof c.prompt === "string" && c.messages === undefined)).toBe(true);
  });

  it("stops between stages", async () => {
    let n = 0;
    const r = await runDeepResearch("q", undefined, undefined, 256, undefined, undefined, () => ++n > 1);
    expect(r.answer).toBe("");
  });
});

describe("runDeepResearch fullCitations (P1)", () => {
  it("returns every cited source as retrieved, aligned with citations, while the prompts get the compressed body", async () => {
    const sentences = Array.from({ length: 9 }, (_, i) => `The French Revolution changed France in its phase number ${i + 1} of the revolution.`);
    const LONG = chunk("long", "French Revolution (phases)", sentences.join(" "));
    sameForAll = [LONG, EU];
    const r = await runDeepResearch("Compare the causes of both revolutions", undefined, undefined, 256);
    expect(r.fullCitations?.map((c) => c.chunkId)).toEqual(r.citations.map((c) => c.chunkId));
    const i = r.citations.findIndex((c) => c.chunkId === "long");
    expect(r.fullCitations![i].body).toBe(LONG.body);
    expect(r.citations[i].body.length).toBeLessThan(LONG.body.length);
  });
});

describe("runDeepResearch partial sources (retrieval progress)", () => {
  const Q = "Compare the causes of both revolutions";
  const ids = (s: RetrievedChunk[]) => s.map((c) => c.chunkId);

  it("sends each sub-question's sources before its sub-answer is generated, as growing prefixes of the final list", async () => {
    const log: string[] = [];
    const partials: RetrievedChunk[][] = [];
    let final: RetrievedChunk[] = [];
    const r = await runDeepResearch(
      Q,
      undefined,
      undefined,
      256,
      (p) =>
        log.push(
          p.stage === "researching"
            ? `${p.answering ? "answering" : "researching"}:${p.subQuestionIndex}:${p.subQuestion}:gen${calls.length}`
            : p.stage
        ),
      undefined,
      undefined,
      {
        onPartialSources: (s, p) => {
          partials.push(s);
          // Generations so far: the decomposition, then one sub-answer per earlier sub-question.
          log.push(`partial:${p.subQuestionIndex}/${p.subQuestionCount}:${ids(s).join(",")}:gen${calls.length}`);
        },
        onSources: (s) => {
          final = s;
          log.push(`final:${ids(s).join(",")}:gen${calls.length}`);
        },
      }
    );
    const f = ids(r.citations).join(",");
    expect(log).toEqual([
      "decomposing",
      "researching:0:What caused the French Revolution?:gen1",
      `partial:0/2:${ids(partials[0]).join(",")}:gen1`,
      // After its search and before its sub-answer: the UI shows the part as being read, new articles or not.
      "answering:0:What caused the French Revolution?:gen1",
      "researching:1:What caused the Industrial Revolution?:gen2",
      `partial:1/2:${f}:gen2`,
      "answering:1:What caused the Industrial Revolution?:gen2",
      `final:${f}:gen3`,
      "synthesizing",
    ]);
    // Numbers never move: every partial list is a prefix of the next and of the final one.
    expect(partials[0].length).toBeGreaterThan(0);
    for (let i = 0; i < partials.length; i++) {
      const next = i + 1 < partials.length ? partials[i + 1] : r.citations;
      expect(ids(next).slice(0, partials[i].length)).toEqual(ids(partials[i]));
    }
    expect(partials[partials.length - 1]).toEqual(r.citations);
    expect(final).toEqual(r.citations);
  });

  it("does not change the sources, their numbers or the prompts", async () => {
    const without = await runDeepResearch(Q, undefined, undefined, 256);
    const promptsWithout = calls.map(text);
    calls.length = 0;
    const withPartial = await runDeepResearch(Q, undefined, undefined, 256, undefined, undefined, undefined, { onPartialSources: () => {} });
    expect(withPartial.citations).toEqual(without.citations);
    expect(withPartial.answer).toBe(without.answer);
    expect(calls.map(text)).toEqual(promptsWithout);
  });

  it("sends nothing for a sub-question that found no new source", async () => {
    sameForAll = [EU];
    const partials: RetrievedChunk[][] = [];
    const r = await runDeepResearch(Q, undefined, undefined, 256, undefined, undefined, undefined, { onPartialSources: (s) => partials.push(s) });
    expect(partials.map(ids)).toEqual([["eu"]]);
    expect(ids(r.citations)).toEqual(["eu"]);
  });

  it("an off-topic source is never in a partial list either", async () => {
    withOffTopic = true;
    const partials: RetrievedChunk[][] = [];
    await runDeepResearch(Q, undefined, undefined, 256, undefined, undefined, undefined, { onPartialSources: (s) => partials.push(s) });
    expect(partials.flat().map((c) => c.title)).not.toContain("Dean Lee");
  });
});

describe("runDeepResearch answer language", () => {
  const Q = "Compare as causas das duas revoluções";
  const LINE = "Responda em português do Brasil, mesmo que as fontes estejam em inglês, e cite cada afirmação com o número da fonte, como [1].";
  const synthesis = () => calls.map(text).find((t) => t.includes("synthesizing multiple research perspectives"))!;

  it("puts the language line after the synthesis input, and only there", async () => {
    const without = await runDeepResearch(Q, undefined, undefined, 256);
    const before = calls.map(text);
    calls.length = 0;
    const withLine = await runDeepResearch(Q, undefined, undefined, 256, undefined, undefined, undefined, { answerLanguage: LINE });
    expect(synthesis().endsWith(`(${LINE})`)).toBe(true);
    // Decomposition and sub-answers: the same prompts, so the same sub-questions and the same retrieval.
    const after = calls.map(text);
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(withLine.subQuestions).toEqual(without.subQuestions);
    expect(withLine.citations).toEqual(without.citations);
  });

  it("no line, no change", async () => {
    await runDeepResearch(Q, undefined, undefined, 256);
    expect(synthesis()).not.toContain("Responda");
  });
});
