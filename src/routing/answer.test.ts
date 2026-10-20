import { describe, it, expect, beforeEach } from "vitest";
import type { RetrievedChunk } from "../rag/retrieve.types";
import { answerPromptPrefix, assemblePrompt, assembleChatMessages } from "../rag/pure";
import { AnswerDeps, createAnswerer, InstalledLlm } from "./answer";
import type { AnswerEvent } from "./events";
import type { AnswerSettings } from "../models/settings";
import type { GenerateOptions } from "../inference/LlamaEngine";
import { approxTokens, HEALTH_GROUNDING_INSTRUCTION, NO_SOURCE_INSTRUCTION, PT_ANSWER_LANGUAGE } from "./context";
import { ModelLoadError } from "../inference/loadError";
import { answerReducer, initialAnswer } from "./answerReducer";

const chunk = (chunkId: string, title: string, body: string): RetrievedChunk => ({
  chunkId,
  docId: chunkId,
  title,
  body,
  score: 1,
  matchType: "hybrid",
});
const WALIPINI_KB = chunk("wk", "Walipini", "A Walipini is an earth-sheltered cold frame. A greenhouse can be built by digging a hole in the ground. It uses the heat stored in the earth during the cold season.");
const CANBERRA = chunk(
  "c1",
  "Canberra",
  "Canberra is the capital city of Australia. Founded following the federation of the colonies of Australia as the seat of government for the new nation, it is Australia's largest inland city. " +
    "The city is located at the northern end of the Australian Capital Territory, 280 km south-west of Sydney and 660 km north-east of Melbourne. " +
    "The site of Canberra was selected for the location of the nation's capital in 1908 as a compromise between Sydney and Melbourne. " +
    "The city was designed by the American architects Walter Burley Griffin and Marion Mahony Griffin after an international design contest."
);
const MOLD = chunk(
  "c2",
  "Mold",
  "A mold or mould is one of the structures that certain fungi can form. The dust-like, colored appearance of molds is due to the formation of spores. " +
    "Molds are considered to be microbes and do not form a specific taxonomic or phylogenetic grouping. Mold growth needs moisture."
);
const HALL = chunk(
  "c3",
  "Hall Primary School",
  "Hall Primary School is a government primary school in the village of Hall, in the Australian Capital Territory. It opened in 1912 and serves students from kindergarten to year six. " +
    "The school has a heritage-listed building and a small library."
);

const GB = 1024 ** 3;
const qwen15: InstalledLlm = { id: "qwen1.5", label: "Qwen 1.5B", filename: "models/q15.gguf", sizeBytes: GB, roles: ["fast"], isDefault: true };
const lfm: InstalledLlm = { id: "lfm8", label: "LFM2.5 8B-A1B", filename: "models/lfm.gguf", sizeBytes: 5 * GB, roles: [] };
const qwen7: InstalledLlm = { id: "qwen7", label: "Qwen 7B", filename: "models/q7.gguf", sizeBytes: 4.7 * GB, roles: ["reasoning", "verifier"] };
const moe: InstalledLlm = { id: "moe30", label: "Qwen3 30B-A3B", filename: "models/moe.gguf", sizeBytes: 11 * GB, roles: ["reasoning"] };

interface Fake {
  deps: AnswerDeps;
  loaded: string | null;
  loads: string[];
  generations: GenerateOptions[];
  concurrent: number;
  maxConcurrent: number;
  multipassCalls: number;
  settings: AnswerSettings;
  installed: InstalledLlm[];
  activeId: string | null;
  retrieved: RetrievedChunk[];
  loadError: string | null;
  verdict: string;
  records: Parameters<NonNullable<AnswerDeps["recordExecution"]>>[0][];
}

function makeFake(): Fake {
  let clock = 0;
  let stopped = false;
  const f: Fake = {
    loaded: null,
    loads: [],
    generations: [],
    concurrent: 0,
    maxConcurrent: 0,
    multipassCalls: 0,
    settings: { quickFirst: true, alwaysComplete: false, deepModelId: undefined },
    installed: [qwen15],
    activeId: "qwen1.5",
    retrieved: [CANBERRA, MOLD, HALL],
    loadError: null,
    verdict: "SUPPORTED. Matches [1].",
    records: [],
    deps: null as unknown as AnswerDeps,
  };
  f.deps = {
    now: () => (clock += 5),
    engine: {
      async load(filename) {
        if (f.loadError) throw new Error(f.loadError);
        f.loads.push(filename);
        f.loaded = filename;
        return { fit: null, warning: filename === moe.filename ? "streams from storage" : null };
      },
      async generate(opts) {
        f.generations.push(opts);
        f.concurrent++;
        f.maxConcurrent = Math.max(f.maxConcurrent, f.concurrent);
        stopped = false;
        await new Promise((r) => setTimeout(r, 5));
        if (opts.messages?.[0]?.content.startsWith("You are checking whether an answer")) {
          f.concurrent--;
          return f.verdict;
        }
        const out: string[] = [];
        for (const piece of ["Canberra ", "is ", "the ", "capital ", "[1]."]) {
          if (stopped) break;
          opts.onToken?.(piece);
          out.push(piece);
          await new Promise((r) => setTimeout(r, 1));
        }
        const promptText = opts.messages?.map((m) => m.content).join("\n") ?? opts.prompt ?? "";
        opts.onTimings?.({ promptTokens: approxTokens(promptText), promptMs: 120, predictedTokens: out.length, predictedMs: 50 });
        f.concurrent--;
        return out.join("");
      },
      async stop() {
        stopped = true;
      },
      getModelInfo: () => (f.loaded ? { filename: f.loaded } : null),
      hasEmbeddedChatTemplate: () => true,
      async estimateFit(filename) {
        return filename === moe.filename ? ({ verdict: "streaming" } as any) : ({ verdict: "resident" } as any);
      },
    },
    retrieve: async () => f.retrieved,
    getSettings: async () => f.settings,
    listInstalledLlms: async () => f.installed,
    getActiveModelId: async () => f.activeId,
    runMultipass: async (_q, _s, _h, _m, onProgress, onToken, _stop, options) => {
      f.multipassCalls++;
      onProgress({ stage: "researching", subQuestionIndex: 0, subQuestionCount: 2 });
      options.onSources?.([CANBERRA, HALL]);
      onProgress({ stage: "synthesizing" });
      onToken("Synth [2].");
      return { answer: "Synth [2].", subQuestions: ["a", "b"], citations: [CANBERRA, HALL] };
    },
    assemblePrompt,
    assembleChatMessages,
    recordExecution: async (r) => {
      f.records.push(r);
    },
  };
  return f;
}

const ctx = { maxTokens: 256 };
let f: Fake;
beforeEach(() => {
  f = makeFake();
});

async function collect(query: string, tier?: "auto" | "fast" | "deep") {
  const events: AnswerEvent[] = [];
  const { answer } = createAnswerer(f.deps);
  const h = answer({ query, tier }, (e) => events.push(e), ctx);
  const result = await h.done;
  return { events, result, h };
}

const types = (events: AnswerEvent[]) => events.map((e) => (e.type === "stage" ? `stage:${e.stage}` : e.type));

describe("answer(): instant tier", () => {
  it("previews a confident lookup from the source, then the model answers (on a PC it never stands alone)", async () => {
    const { events, result } = await collect("What is the capital of Australia?");
    expect(types(events).slice(0, 3)).toEqual(["stage:retrieving", "sources", "instant"]);
    expect(result.tier).toBe("fast");
    expect(result.receipt.reasonCodes).not.toContain("instant:final");
    expect(f.generations).toHaveLength(1);
    const instant = events.find((e) => e.type === "instant")!;
    // sourceIndex points into the emitted (compressed) sources.
    const sources = (events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
    expect(sources[(instant as any).snippet.sourceIndex].title).toBe("Canberra");
    expect(sources.map((s) => s.title)).not.toContain("Mold");
  });

  it("'Answer anyway' runs the model even when the source excerpt could stand as the answer", async () => {
    // The excerpt is already on screen above the decline: asking again with answerAnyway must reach the
    // model, not end on the same excerpt (iPhone 13, 01/10: with quick answers on, the tap re-ran the
    // question, instant:final returned the excerpt, and the model never ran).
    const events: AnswerEvent[] = [];
    const result = await createAnswerer(f.deps).answer({ query: "What is the capital of Australia?", answerAnyway: true }, (e) => events.push(e), ctx).done;
    expect(result.tier).toBe("fast");
    expect(result.receipt.reasonCodes).toContain("instant:off");
    expect(result.receipt.reasonCodes).not.toContain("instant:final");
    expect(types(events)).not.toContain("instant");
    expect(f.generations).toHaveLength(1);
  });

  it("keeps generating when the confident snippet can't answer the question alone", async () => {
    const { events, result } = await collect("What is the capital of Australia and where is it?");
    expect(types(events)).toContain("instant");
    expect(result.tier).toBe("fast");
    expect(result.receipt.reasonCodes).not.toContain("instant:final");
    expect(f.generations).toHaveLength(1);
  });

  it("every event carries the same answerId", async () => {
    const { events, result } = await collect("Why was Canberra chosen as the capital?");
    expect(new Set(events.map((e) => e.answerId))).toEqual(new Set([result.answerId]));
  });
});

describe("answer(): grounding guard (Prism Q-1, E-1)", () => {
  const DEAN_LEE = chunk(
    "dl",
    "Dean Lee",
    "Dean Lee (born 1971) is an American nuclear theorist. He also works on new technologies and computational paradigms such as eigenvector continuation, machine learning tools to find correlations, and quantum computing algorithms for the nuclear many-body problem."
  );
  const PUBLIC_KEY = chunk(
    "pk",
    "Public-key cryptography",
    "Public-key cryptography is the field of cryptographic systems that use pairs of related keys. There are many kinds of public-key cryptosystems, including digital signature, Diffie-Hellman key exchange and public-key encryption."
  );
  const NOSEBLEED = chunk(
    "nb",
    "Nosebleed",
    "A nosebleed is bleeding from the nose. Pinch the soft part of the nose and lean forward for ten minutes. At home, the head should not be tilted back."
  );

  it("Q-1 without the crypto pack: off-topic sources are dropped; the model answers as 'not from the offline library'", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [DEAN_LEE, PUBLIC_KEY];
    const { events, result } = await collect("Which signature algorithms are quantum resistant?");
    expect(events.some((e) => e.type === "instant")).toBe(false);
    expect(events.some((e) => e.type === "sources")).toBe(false);
    expect(events.filter((e) => e.type === "warning")).toEqual([expect.objectContaining({ code: "weak_sources" })]);
    expect(f.generations).toHaveLength(1);
    expect(f.generations[0].messages!.at(-1)!.content).toContain(NO_SOURCE_INSTRUCTION);
    expect(f.generations[0].messages!.map((m) => m.content).join("\n")).not.toContain("Dean Lee");
    expect(result.sources).toEqual([]);
    expect(result.receipt.reasonCodes).toEqual(expect.arrayContaining(["grounding:off-topic-dropped-2", "grounding:no-good-source", "grounding:no-source-memory"]));
  });

  it("drops an off-topic source when an on-topic one exists", async () => {
    f.retrieved = [DEAN_LEE, CANBERRA];
    const { events } = await collect("Why was Canberra chosen as the capital of Australia?");
    const sources = (events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
    expect(sources.map((c) => c.title)).toEqual(["Canberra"]);
  });

  it("E-1 nosebleed: the answer is the source's own text, cited, with no model", async () => {
    f.retrieved = [NOSEBLEED];
    const { result } = await collect("How do I stop a nosebleed?");
    expect(f.generations).toHaveLength(0);
    expect(result.tier).toBe("instant");
    expect(result.receipt.modelId).toBe("extractive");
    expect(result.text).toBe(
      // Steps first: the definition sentence is skipped.
      "From the offline source:\nPinch the soft part of the nose and lean forward for ten minutes. At home, the head should not be tilted back. [1]\n\nIn an emergency, call your local emergency number (911 in the US, 112 in Europe)."
    );
    expect(result.receipt.reasonCodes).toContain("grounding:health-extractive");
  });

  it("E-1: quotes the source that says what to do, not the definition", async () => {
    const lead = chunk("n1", "Nosebleed", "A nosebleed, also known as epistaxis, is bleeding from the nasal cavity. Most cases are minor.");
    const treatment = chunk(
      "n2",
      "Nosebleed",
      "Treatment: Most anterior nosebleeds can be stopped by applying direct pressure. Pinch the soft part of the nose and lean forward for 10 to 15 minutes."
    );
    f.retrieved = [lead, treatment];
    const { result } = await collect("How do I stop a nosebleed?");
    // Starts at the core procedure (pinch, lean forward), then the emergency line.
    expect(result.text).toMatch(/^From the offline source:\nTreatment: (Most anterior nosebleeds .*)?Pinch the soft part of the nose and lean forward for 10 to 15 minutes\. \[\d\]\n\nIn an emergency, call your local emergency number/);
  });

  it("EQ-2/DUP-1: a health answer is the excerpt with its steps, from the cited source, and no separate instant event", async () => {
    const run = { ...chunk("wv", "Wikivoyage: Earthquake safety", "During an earthquake: Do not run during the quake! Running around during the quake is dangerous."), action: true };
    const drop = { ...chunk("ap", "Appropedia: How to survive an earthquake", "During an earthquake: Drop, cover, and hold on! Drop to the floor. Take cover under a sturdy table. Hold on until the shaking stops."), action: true };
    f.retrieved = [run, drop] as any;
    const { events, result } = await collect("What should I do during an earthquake?");
    // DUP-1: no instant event at all; the answer is the excerpt, with its steps, citing the source it quotes.
    expect(events.filter((e) => e.type === "instant")).toHaveLength(0);
    expect(result.text).toMatch(/Drop, cover, and hold on! Drop to the floor\. Take cover under a sturdy table\. Hold on until the shaking stops\./);
    expect(result.text).not.toMatch(/Do not run/);
    const sources = (events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
    const cited = (events.find((e) => e.type === "done") as any).cited as number[];
    expect(sources[cited[0] - 1].chunkId).toBe("ap");
  });

  it("E-1 PT nosebleed: searches the English packs with English words and answers from the source", async () => {
    const queries: string[] = [];
    f.deps.retrieve = async (q) => (queries.push(q), [NOSEBLEED]);
    const { result } = await collect("Como faço para parar um sangramento no nariz?");
    expect(queries).toEqual(["nosebleed nose bleed stop what to do"]);
    expect(result.text).toMatch(/^Da fonte offline \(em inglês\):\nPinch the soft part/);
    expect(f.generations).toHaveLength(0);
  });

  it("gate 5e70bbd: a what-to-do question keeps its intent in the search, so the pack lifts Treatment", async () => {
    const queries: string[] = [];
    f.deps.retrieve = async (q) => (queries.push(q), []);
    await collect("My friend was bitten by a snake on a hike. How do we treat the bite?");
    await collect("Tell me about snakebite statistics in India");
    expect(queries).toEqual(["snakebite snake bite what to do", "Tell me about snakebite statistics in India"]);
  });

  it("uses the pack's action flag (Bramble b4becc5): an action section wins, a background one is never quoted over it", async () => {
    const quality = { ...chunk("wq", "Wikivoyage: Water", "Quality by country or region: Pinch tap water is safe to drink in most of the EU, keep an eye on it."), action: false };
    const contamination = { ...chunk("wc", "Wikivoyage: Water", "Water contamination: boil water for one minute at a rolling boil before you drink it."), action: true };
    const stayHealthy = { ...chunk("sh", "Wikivoyage: Stay healthy", "During your trip > Precautions against disease > Water contamination: After a flood, boil water for one minute at a rolling boil before you drink it."), action: true };
    f.retrieved = [stayHealthy, quality] as any;
    const first = await collect("After a flood the tap water might be contaminated. How do I make water safe to drink?");
    // Topic named by the section heading, not the article title (gate 5e70bbd, safety-005).
    expect(first.result.text).toMatch(/Water contamination: After a flood, boil water .* \[\d\]\n\nIn an emergency/);
    f = makeFake();
    f.retrieved = [quality, contamination] as any;
    const { result } = await collect("After a flood the tap water might be contaminated. How do I make water safe to drink?");
    expect(result.text).toMatch(/^(?:The offline library has no guidance specific to a flood; the passage below is general advice on the subject\.\n\n)?From the offline source:\nWater contamination: boil water for one minute .* \[\d\]\n\nIn an emergency/);
  });

  it("E-1 'Deeper answer' on a health question: the model may only restate the sources", async () => {
    f.installed = [qwen15, moe];
    f.retrieved = [NOSEBLEED];
    const { result } = await collect("How do I stop a nosebleed?", "deep");
    expect(result.receipt.reasonCodes).toContain("grounding:health-no-multipass");
    expect(f.multipassCalls).toBe(0);
    expect(f.generations).toHaveLength(1);
    expect(f.generations[0].messages!.at(-1)!.content).toContain(HEALTH_GROUNDING_INSTRUCTION);
  });

  it("'Deeper answer' on health: temperature 0, nothing streamed, and a dangerous model line falls back to the source", async () => {
    f.installed = [qwen15, moe];
    f.retrieved = [NOSEBLEED];
    const seen: any[] = [];
    f.deps.engine.generate = async (o) => {
      seen.push(o);
      o.onToken?.("streamed");
      return "Pinch the soft part of your nose and blow your nose gently [1].";
    };
    const { events, result } = await collect("How do I stop a nosebleed?", "deep");
    expect(seen[0].temperature).toBe(0);
    expect(events.filter((e) => e.type === "token").map((e: any) => e.text)).toEqual([result.text]);
    expect(result.text).toMatch(/^From the offline source:\nPinch the soft part of the nose/);
    expect(result.receipt.reasonCodes).toContain("grounding:health-unsafe-blow-nose");
  });

  it("gate 715ffdd: a health excerpt never comes from a source whose title isn't the topic", async () => {
    const cases: [string, RetrievedChunk][] = [
      ["My friend was bitten by a snake on a hike. How do we treat the bite?", chunk("r", "Renealmia cernua", "Renealmia cernua is a plant. Its leaves are used against snakebite in folk medicine.")],
      ["My hiking partner is shivering, confused and slurring words in the cold. What should I do?", chunk("s", "Schroeder Pants Cave", "Schroeder Pants Cave is a cave. Cavers risk hypothermia when shivering in the cold water.")],
      ["An earthquake starts while I'm inside a hotel room. What should I do?", chunk("h", "Hotel Impossible", "Hotel Impossible is a TV show. One episode covered a hotel after an earthquake.")],
      ["After a flood the tap water might be contaminated. How do I make water safe to drink?", chunk("a", "After-rust", "After-rust is a plant disease. Contaminated water after a flood spreads it; it is not safe to drink.")],
      ["My child spilled boiling water on their arm. What do I do?", chunk("b", "Ethereum EIPs/ERCs: EIP-7775: BURN opcode", "Abstract: This EIP adds a BURN opcode that burns ether.")],
    ];
    for (const [q, off] of cases) {
      f = makeFake();
      f.retrieved = [off];
      const { result } = await collect(q);
      expect(result.text, q).toMatch(/don't have a reliable offline source/);
      expect(result.sources, q).toEqual([]);
      expect(f.generations).toHaveLength(0);
    }
  });

  it("…and still quotes the on-topic ones", async () => {
    for (const [q, on] of [
      ["My friend was bitten by a snake on a hike. How do we treat the bite?", chunk("sb", "Snakebite", "Treatment > First aid: Keep the person calm and still, remove rings and watches, and get to a hospital for antivenom.")],
      ["After a flood the tap water might be contaminated. How do I make water safe to drink?", chunk("w", "Wikivoyage: Stay healthy", "During your trip > Water contamination: After a flood, boil water for one minute at a rolling boil before you drink it.")],
      ["An earthquake starts while I'm inside a hotel room. What should I do?", chunk("e", "Earthquakes (Ready.gov)", "During an Earthquake: Drop, cover, and hold on. Stay inside until the shaking stops.")],
    ] as const) {
      f = makeFake();
      f.retrieved = [on];
      const { result } = await collect(q);
      expect(result.text, q).toMatch(/^From the offline source:/);
      expect(result.sources.map((c) => c.title), q).toEqual([on.title]);
    }
  });

  it("Iris E-1: 'What should I do during an earthquake?' with only a heading + image caption: no model, emergency services, safety line", async () => {
    // Since cry-012 the caption-only passage carries no content and is dropped: the no-source answer
    // (emergency services), instead of quoting "Image" as what the source says.
    f.retrieved = [chunk("eq", "Earthquakes (Ready.gov)", "During an Earthquake > Protect Yourself During Earthquakes: Image")];
    const { events, result } = await collect("What should I do during an earthquake?");
    expect(f.generations).toHaveLength(0);
    expect(result.text).toMatch(/emergency number/);
    expect(result.receipt.reasonCodes).toContain("context:no-content-dropped-1");
    expect(events.find((e) => e.type === "done")).toMatchObject({ safety: true });
  });

  it("disaster with no on-topic source: emergency line, no model; history of a disaster is an ordinary question", async () => {
    f.retrieved = [];
    const { events, result } = await collect("What should I do during an earthquake?");
    expect(f.generations).toHaveLength(0);
    expect(result.text).toMatch(/emergency number/);
    expect(events.find((e) => e.type === "done")).toMatchObject({ safety: true });
    f = makeFake();
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    const hist = await collect("What caused the 1906 San Francisco earthquake?");
    // Science or history of a disaster: no emergency line, an ordinary model answer (Sextant q6, Quill 31c1ee8).
    expect((hist.events.find((e) => e.type === "done") as any).safety).toBeUndefined();
    expect(f.generations).toHaveLength(1);
  });

  it("Iris 54202b7: the source list shown for a health question is the filtered one, empty with no on-topic source", async () => {
    f.retrieved = [
      chunk("x1", "Ancraophobia", "Ancraophobia is the fear of wind. Sufferers may bleed from the nose in panic, some reports say."),
      chunk("x2", "Tickling", "Tickling is the act of touching a part of the body so as to cause involuntary laughter."),
      chunk("x3", "Eminectomy", "Eminectomy is a surgical procedure. Nosebleed is a rare complication."),
      chunk("x4", "Guitar", "A guitar is a fretted musical instrument."),
      chunk("x5", "Stop sign", "A stop sign is a traffic sign."),
      chunk("x6", "Nose flute", "The nose flute is played with the nose."),
    ];
    const { events, result } = await collect("How do I stop a nosebleed?");
    expect(events.some((e) => e.type === "sources")).toBe(false);
    expect(events.some((e) => e.type === "instant")).toBe(false);
    expect(result.sources).toEqual([]);
    expect(result.text).toMatch(/don't have a reliable offline source/);
    expect(f.generations).toHaveLength(0);

    f = makeFake();
    f.retrieved = [chunk("x1", "Ancraophobia", "Ancraophobia is the fear of wind."), NOSEBLEED];
    const onTopic = await collect("How do I stop a nosebleed?");
    const shown = (onTopic.events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
    expect(shown.map((c) => c.title)).toEqual(["Nosebleed"]);
    expect(onTopic.result.sources.map((c) => c.title)).toEqual(["Nosebleed"]);
  });

  it("gate ee1f2b7 BLOCKER: a scald described in PT ('fervendo') is health: source text only, never a free model answer", async () => {
    const queries: string[] = [];
    f.deps.retrieve = async (q) => (queries.push(q), [chunk("b", "Burn", "Management: Cool the burn under cool running water for 20 minutes. Do not use ice, butter or creams.")]);
    const { result } = await collect("Meu filho derramou água fervendo no braço. O que eu faço?");
    expect(queries).toEqual(["burn scald what to do"]);
    expect(f.generations).toHaveLength(0);
    expect(result.text).toMatch(/^Da fonte offline \(em inglês\):\nManagement: Cool the burn/);
  });

  it("gate ee1f2b7: PT health answers never cite a title that only shares a generic word", async () => {
    for (const [q, off] of [
      ["Fui picado por uma cobra na trilha. O que eu faço?", chunk("t", "Tree snake", "Tree snakes live in trees and rarely bite people.")],
      ["O que fazer durante um terremoto?", chunk("j", "Just Stop Oil", "Just Stop Oil is a climate campaign group.")],
      ["Depois de uma enchente, como deixo a água segura para beber?", chunk("c", "California Department of Water Resources", "The department manages water supply in California.")],
      ["My child spilled boiling water on their arm. What do I do?", { ...chunk("o", "Oral rehydration therapy", "Treatment algorithm: give oral rehydration solution in small sips."), action: true }],
      ["My child spilled boiling water on their arm. What do I do?", { ...chunk("h", "Appropedia: Hog Butchering and Smoking", "SCALDING: A hog must be bled and scalded in hot water before scraping."), action: false }],
    ] as const) {
      f = makeFake();
      f.retrieved = [off as any];
      const { events, result } = await collect(q);
      expect(events.some((e) => e.type === "sources"), q).toBe(false);
      expect(result.sources, q).toEqual([]);
      expect(f.generations, q).toHaveLength(0);
    }
  });

  it("Bramble 0d82f09: a lay first-aid source that names the condition in its text is quoted over the clinical one", async () => {
    f.retrieved = [
      { ...chunk("c", "Snakebite", "Treatment > First aid: Some have little local effect, but life-threatening systemic effects, in which case pressure immobilization is desirable."), action: true },
      { ...chunk("l", "US government: US Army Survival Manual FM 21-76: CHAPTER 4 - BASIC SURVIVAL MEDICINE", "Before you start treating a snakebite, keep the victim still, remove rings and watches, and get medical help."), action: false },
    ] as any;
    const { result } = await collect("My friend was bitten by a snake on a hike. How do we treat the bite?");
    expect(result.text).toMatch(/Before you start treating a snakebite, keep the victim still/);
  });

  it("safety-008 (real pack text): quotes Drop, Cover and Hold over 'Do not run', and always ends with the emergency line", async () => {
    const LABEL_US = "US government: Earthquakes (Ready.gov)";
    for (const q of ["What should I do during an earthquake?", "O que eu faço durante um terremoto?"]) {
      f = makeFake();
      f.retrieved = [
        { ...chunk("r", LABEL_US, "During an Earthquake > Protect Yourself During Earthquakes: Image"), action: true },
        { ...chunk("d", "Wikivoyage: Earthquake safety", "During an earthquake: Do not run during the quake! Standing up, walking and, most of all, running are things that you should avoid, as you are likely to fall over and thereby injure yourself. Crawling may be the only way of getting around if you absolutely have to.\n\nA moderate-to-large earthquake usually persists less than a minute (though the exceptionally powerful 2011 Japan earthquake lasted for six minutes), but that is more than long enough to cause damage. Often it will be followed by aftershocks. Do not be complacent after an earthquake seems to be over\u2014get to safety!"), action: true },
        { ...chunk("i", "Wikivoyage: Earthquake safety", "During an earthquake > If you are indoors: The U.S. FEMA and the New Zealand Civil Defence give the advice \"Drop, Cover and Hold\" in the case of an earthquake.\n\nStay indoors. Get down on the floor on your knees and bow down, cover your head and neck, and take cover under a table, desk, or some other sturdy furniture if possible. Hold on to the table to prevent the shaking from separating you from your cover. If possible, shelter under furniture that is next to interior walls, away from windows and tall furniture (such as wardrobes and tall shelves), which could topple over on you. You are far safer if you stay indoors: falling roof tiles, chimney bricks, power lines, and other falling objects outside usually present the deadliest hazards. Doorways in modern buildings are not strong or safe places."), action: true },
      ] as any;
      const { result } = await collect(q);
      expect(result.text, q).toMatch(/Drop, Cover and Hold/);
      expect(result.text, q).toMatch(/emergency number|serviço de emergência/);
      expect(f.generations, q).toHaveLength(0);
    }
  });

  it("Boar decision A (real Ready.gov text): a burn excerpt stops before any ointment/cream/oil/aloe line", async () => {
    const READY_GOV_BURNS = "How to Treat Minor Burns: - Remove all clothing, diapers, jewelry and metal from the burned area. These can hide underlying burns and retain heat, which can increase skin damage.\n- Use cool water, not cold water or ice. The extreme cold from ice can cause additional injury.\n- If possible, particularly if the burn is caused by chemicals, hold the burned skin under cool running water for 10 to 15 minutes until it is less painful. Use a sink, shower or garden hose.\n- If you don\u2019t have access to cool running water, put a cool, clean wet cloth on the burn, or soak the burn in a cool water bath for five minutes.\n- Clean the burn gently with soap and water.\n- Do not break blisters. An opened blister can get infected.\n- You may put a thin layer of ointment, such as petroleum jelly or aloe vera on the burn. The ointment does not need to have antibiotics in it. Some antibiotic ointments can cause an allergic reaction. Do not use cream, lotion, oil, cortisone, butter, or egg white.\n- You can cover the burn with a sterile non-stick gauze lightly taped or wrapped over it. But don\u2019t use one that can shed fibers, because they can get caught in the burn. Change the dressing once a day.";
    for (const q of ["My child spilled boiling water on their arm. What do I do?", "Meu filho derramou água fervendo no braço. O que eu faço?", "How do I treat a burn?"]) {
      f = makeFake();
      f.retrieved = [{ ...chunk("r", "US government: Preventing and Treating Burns (Ready.gov)", READY_GOV_BURNS), action: true }] as any;
      const { result } = await collect(q);
      expect(result.text, q).toMatch(/Remove all clothing, diapers, jewelry and metal/);
      expect(result.text, q).toMatch(/cool running water for 10 to 15 minutes/);
      expect(result.text, q).toMatch(/Do not break blisters/);
      expect(result.text, q).not.toMatch(/ointment|petroleum jelly|aloe|butter|\blotion\b/i);
      expect(result.text, q).toMatch(/emergency number|serviço de emergência/);
    }
  });

  it("for a child or boiling water, the source's 'seek medical care' line is kept even past the cut", async () => {
    f.retrieved = [{ ...chunk("b", "Burn", "Management: Cool the burn under cool running water for 20 minutes. You may apply aloe vera gel. Seek medical care for any burn on a child."), action: true }] as any;
    const { result } = await collect("My child spilled boiling water on their arm. What do I do?");
    expect(result.text).toMatch(/Cool the burn under cool running water for 20 minutes\. Seek medical care for any burn on a child\./);
    expect(result.text).not.toMatch(/aloe/i);
  });

  it("gate 2329dc0: a disaster answer never cites an article about one event (Marash, Kamchatka)", async () => {
    for (const q of ["An earthquake starts while I'm inside a hotel room. What should I do?", "O que fazer durante um terremoto?"]) {
      f = makeFake();
      f.retrieved = [
        chunk("m", "The 1513 Marash earthquake", "The 1513 Marash earthquake struck southern Anatolia. During the earthquake many buildings collapsed."),
        chunk("k", "1952 Kamchatka earthquake", "The 1952 Kamchatka earthquake caused a tsunami. After the earthquake, people moved to high ground."),
      ];
      const { events, result } = await collect(q);
      expect(events.some((e) => e.type === "sources"), q).toBe(false);
      expect(result.text, q).toMatch(/emergency|emergência/);
      expect(f.generations, q).toHaveLength(0);
    }
  });

  it("…while a generic safety article or a pack action section still counts", async () => {
    for (const on of [
      chunk("g", "Wikivoyage: Earthquake safety", "During an earthquake: Drop, cover, and hold on until the shaking stops."),
      chunk("r", "US government: Earthquakes (Ready.gov)", "During an Earthquake: Drop, cover, and hold on."),
      // safety-008 with Bramble 55071af: the Wikibooks guide's title is generic too.
      { ...chunk("w", "Wikibooks: How to survive an earthquake", "During an earthquake: Drop, cover, and hold on! Get under a sturdy table."), action: true },
      { ...chunk("a", "Emergency shelter", "During an earthquake: drop, cover and hold on under a sturdy table."), action: true },
    ]) {
      f = makeFake();
      f.retrieved = [on as any];
      const { result } = await collect("What should I do during an earthquake?");
      expect(result.sources.map((c) => c.title), on.title).toEqual([on.title]);
      expect(result.text).toMatch(/Drop, cover,? and hold on/i);
    }
  });

  it("E-1 snake bite / burn without a good source: emergency services, no model", async () => {
    for (const [q, retrieved] of [
      ["What should I do after a snake bite?", []],
      ["How do I treat a burn?", [MOLD]],
      ["O que fazer em caso de picada de cobra?", []],
    ] as const) {
      f = makeFake();
      f.retrieved = [...retrieved];
      const { result } = await collect(q);
      expect(f.generations).toHaveLength(0);
      expect(result.text).toMatch(/emergency|emergência/);
      // A snakebite first-aid question gets the WHO card now (after 3ffd7e0); the burn, the no-source answer.
      expect(result.receipt.reasonCodes).toContain(/cobra|snake/.test(q) ? "answer:first-aid-card-snakebite" : "grounding:health-no-source");
    }
  });

  it("leaves Portuguese questions alone (English sources can't be matched word for word)", async () => {
    f.retrieved = [CANBERRA];
    const { result } = await collect("Por que Canberra virou a capital da Austrália?");
    expect(f.generations).toHaveLength(1);
    expect(result.receipt.reasonCodes.some((c) => c.startsWith("grounding:"))).toBe(false);
  });
});

describe("answer(): CR-1 low-RAM phone (3.8 GB)", () => {
  const qwen4: InstalledLlm = { id: "qwen4", label: "Qwen3 4B", filename: "models/q4.gguf", sizeBytes: 2.5 * GB, roles: ["fast"], answerTier: "default", isDefault: true };
  const compact: InstalledLlm = { ...qwen15, answerTier: "compact", isDefault: false };
  beforeEach(() => {
    f.deps.deviceRamBytes = () => 3.8 * GB;
  });

  it("a saved 4B that the user never confirmed is not loaded; the compact one answers", async () => {
    f.installed = [qwen4, compact];
    f.activeId = "qwen4";
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.loads).toEqual([compact.filename]);
    expect(result.receipt.reasonCodes).toContain("model:low-ram-unconfirmed-qwen4");
  });

  it("the user's confirmation lets it run", async () => {
    f.installed = [qwen4, compact];
    f.activeId = "qwen4";
    f.settings = { ...f.settings, largeModelConfirmedIds: ["qwen4"] };
    await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.loads).toEqual([qwen4.filename]);
  });

  it("a saved untiered 1.3 GB model the user never confirmed is still used (only the automatic pick skips it)", async () => {
    const hf13: InstalledLlm = { id: "hf-1.3", label: "Llama 3.2 1B Q8_0", filename: "models/hf13.gguf", sizeBytes: 1.3e9, roles: ["fast"], isDefault: false };
    f.installed = [hf13, compact];
    f.activeId = hf13.id;
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.loads).toEqual([hf13.filename]);
    expect(result.receipt.reasonCodes.some((c) => c.startsWith("model:low-ram-unconfirmed"))).toBe(false);
    expect(await createAnswerer(f.deps).effectiveModel()).toEqual({ id: hf13.id, label: hf13.label });
  });

  it("no automatic deep model or verifier above the compact size", async () => {
    f.installed = [compact, { ...moe, sizeBytes: 11 * GB }, qwen7];
    f.activeId = compact.id;
    await collect("Why was Canberra chosen as the capital of Australia?", "deep");
    expect(f.loads.every((l) => l === compact.filename)).toBe(true);
  });

  it("effectiveModel tells the header what will answer, and what it replaces", async () => {
    f.installed = [qwen4, compact];
    f.activeId = "qwen4";
    const { effectiveModel } = createAnswerer(f.deps);
    expect(await effectiveModel()).toEqual({ id: compact.id, label: compact.label, downgradedFrom: { id: "qwen4", label: "Qwen3 4B", reason: "low-ram" } });
    f.settings = { ...f.settings, largeModelConfirmedIds: ["qwen4"] };
    expect(await effectiveModel()).toEqual({ id: "qwen4", label: "Qwen3 4B" });
    f.settings = { ...f.settings, largeModelConfirmedIds: [], loadCrashedIds: ["qwen4"] };
    expect((await effectiveModel())?.downgradedFrom?.reason).toBe("load-crashed");
  });

  it("only big models installed: a clear error instead of an OOM kill", async () => {
    f.installed = [qwen4];
    f.activeId = null;
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.loads).toEqual([]);
    expect(result.outcome).toBe("error");
    expect(result.receipt).toBeDefined();
    expect((await collect("Why was Canberra chosen?")).events.at(-1)).toMatchObject({ type: "done", error: { code: "no_model", message: expect.stringMatching(/too large for this computer's memory/) } });
  });
});

describe("answer(): topic guard for every snippet (Prism RT-1)", () => {
  const WALIPINI = chunk(
    "wp",
    "Walipini",
    "A Walipini is an earth-sheltered cold frame. A greenhouse can be built by digging a hole in the ground. This takes advantage of the heat stored in the earth during the cold season."
  );
  const HOT_WEATHER = chunk(
    "hw",
    "Wikivoyage: Hot weather",
    "Understand: The Earth's axis is tilted by 23 degrees in relation to the ecliptic, and this causes the seasons of winter, spring, summer, and autumn. When your part of Earth is tilted toward the Sun, you get summer."
  );

  it("no 'From the source' from Walipini for the seasons question; the on-topic page stays", async () => {
    f.retrieved = [WALIPINI, HOT_WEATHER];
    const { events } = await collect("Why do we have seasons on Earth?");
    const sources = (events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
    expect(sources.map((c) => c.title)).toEqual(["Wikivoyage: Hot weather"]);
    const instant = events.find((e) => e.type === "instant") as any;
    if (instant) expect(sources[instant.snippet.sourceIndex].title).toBe("Wikivoyage: Hot weather");
  });

  it("PT-1: a PT question is matched with the lexicon's English names, with or without accents", async () => {
    const SEASON = chunk("se", "Season", "A season is a division of the year based on changes in weather. Seasons result from Earth's axial tilt relative to the plane of its orbit around the Sun.");
    for (const q of ["Por que existem as estações do ano?", "Por que existem as estacoes do ano?"]) {
      f = makeFake();
      const HURRICANE = chunk("hs", "US government: Hurricane Season Preparedness Digital Toolkit (Ready.gov)", "Prepare before hurricane season starts. The Atlantic hurricane season starts June 1.");
      f.retrieved = [HURRICANE, WALIPINI, SEASON];
      const queries: string[] = [];
      const retrieve = f.deps.retrieve;
      f.deps.retrieve = (query, k) => (queries.push(query), retrieve(query, k));
      f.deps.englishNames = (query) => (/esta(ç|c)(õ|o)es do ano/i.test(query) ? ["Season"] : []);
      const { events, result } = await collect(q);
      const sources = (events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
      expect(sources.map((c) => c.title), q).toEqual(["Season"]);
      expect(queries, q).toEqual([q]); // retrieve() translates a PT question itself
      expect(result.receipt.reasonCodes).toContain("match:pt-en-names");
      const instant = events.find((e) => e.type === "instant") as any;
      expect(instant && sources[instant.snippet.sourceIndex].title, q).toBe("Season");
    }
    // Without the names, no English title is named by the PT words: the guard keeps nothing.
    f = makeFake();
    f.retrieved = [WALIPINI, { ...WALIPINI, chunkId: "se", title: "Season" }];
    f.deps.englishNames = () => [];
    const { events } = await collect("Por que existem as estacoes do ano?");
    expect(events.find((e) => e.type === "instant")).toBeUndefined();
  });

  it("Boar, gate 9ef80f9: an uncited sentence an on-topic source supports gets its [n]; an unsupported one never", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [CANBERRA];
    f.deps.engine.generate = async () => "Canberra is the capital city of Australia and its largest inland city. It was chosen by a referendum in 1911.";
    const { events, result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(result.text).toBe("Canberra is the capital city of Australia and its largest inland city [1]. It was chosen by a referendum in 1911.");
    const done = events.find((e) => e.type === "done") as any;
    expect(done.finalText).toBe(result.text);
    expect(done.cited).toEqual([1]);
    expect(result.receipt.reasonCodes).toContain("citations:added-1");
  });

  it("Boar, s32: a 4B answer with an on-topic source gets no line even uncited", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [CANBERRA];
    f.deps.engine.generate = async () => "It was chosen by a referendum in 1911.";
    const { events, result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect((events.find((e) => e.type === "done") as any).finalText).toBeUndefined();
    expect(result.receipt.reasonCodes).toContain("grounding:uncited-on-topic");
  });

  it("gate ea5978c: a PT question whose only passage is off topic: no sources shown, the 4B's answer gets the line", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [WALIPINI_KB];
    f.deps.englishNames = () => [];
    f.deps.engine.generate = async () => "As estações existem por causa da inclinação do eixo.";
    const { events } = await collect("Por que existem as estacoes do ano?");
    expect(events.find((e) => e.type === "sources")).toBeUndefined();
    expect((events.find((e) => e.type === "done") as any).finalText).toBe("Esta resposta não vem de uma fonte offline deste computador; confira antes de confiar nela.\n\nAs estações existem por causa da inclinação do eixo.");
  });

  it("gate ea5978c: the compact model with no on-topic source declines; answerAnyway keeps the answer with the line", async () => {
    const q = "Por que existem as estacoes do ano?";
    f.retrieved = [WALIPINI_KB];
    f.deps.englishNames = () => [];
    const { events } = await collect(q);
    expect(f.generations).toHaveLength(0);
    expect(events.find((e) => e.type === "sources")).toBeUndefined();
    expect(events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true });

    f = makeFake();
    f.retrieved = [WALIPINI_KB];
    f.deps.englishNames = () => [];
    f.deps.engine.generate = async () => "Por causa da inclinação.";
    const events2: AnswerEvent[] = [];
    await createAnswerer(f.deps).answer({ query: q, answerAnyway: true }, (e) => events2.push(e), ctx).done;
    expect((events2.find((e) => e.type === "done") as any).finalText).toMatch(/^Esta resposta não vem de uma fonte offline/);
  });

  it("Quill 014c054: an off-topic passage never reaches the sources event, EN or PT, single pass or multipass", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [WALIPINI_KB, CANBERRA];
    f.deps.englishNames = () => [];
    for (const q of ["Por que Canberra foi escolhida como capital da Austrália?", "Why was Canberra chosen as the capital of Australia?"]) {
      const { events } = await collect(q);
      const sources = (events.find((e) => e.type === "sources") as any)?.sources ?? [];
      expect(sources.map((c: RetrievedChunk) => c.title), q).toEqual(["Canberra"]);
    }
  });

  it("gate 1724fd5: the compact model with a source in its prompt and no [n] declines (was Boar (B)); answerAnyway keeps it", async () => {
    f.retrieved = [CANBERRA];
    f.deps.engine.generate = async () => "It was chosen by a referendum in 1911.";
    const { events, result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true, message: "The passages found don't support this answer." });
    expect(result.text).toBe("The passages found don't support this answer.");
    expect(result.receipt.reasonCodes).toContain("grounding:uncited-with-sources-declined-compact");
    f = makeFake();
    f.retrieved = [CANBERRA];
    f.deps.engine.generate = async () => "It was chosen by a referendum in 1911.";
    const events2: AnswerEvent[] = [];
    const r2 = await createAnswerer(f.deps).answer({ query: "Why was Canberra chosen as the capital of Australia?", answerAnyway: true }, (e) => events2.push(e), ctx).done;
    expect(r2.text).toMatch(/referendum/);
  });

  it("gate 1724fd5, cry-011 PT: no [n] -> the decline; a valid [n] -> the answer stays", async () => {
    const EIP = chunk("e", "Ethereum EIPs/ERCs: EIP-1559: Fee market change for ETH 1.0 chain", "Abstract: A transaction pricing mechanism that includes fixed-per-block network fee that is burned and dynamically expands/contracts block sizes to deal with transient congestion.");
    const q = "O que a EIP-1559 muda nas taxas de transação do Ethereum, e o que acontece com a taxa base?";
    f.retrieved = [EIP];
    f.deps.englishNames = () => ["Ethereum"];
    f.deps.engine.generate = async () => "A EIP-1559 introduz uma taxa base que é queimada e ajusta o tamanho dos blocos.";
    const without = await collect(q);
    expect(without.result.text).toBe("Os trechos encontrados não sustentam esta resposta.");
    expect(without.result.receipt.reasonCodes).toContain("grounding:uncited-with-sources-declined-compact");
    f = makeFake();
    f.retrieved = [EIP];
    f.deps.englishNames = () => ["Ethereum"];
    // A [n] CT-1 can verify (the sentence shares the source's key words) stays: the answer is kept.
    f.deps.engine.generate = async () => "EIP-1559 introduces a transaction pricing mechanism with a fixed-per-block network fee that is burned [1].";
    const withCite = await collect(q);
    expect(withCite.result.text).toMatch(/\[1\]/);
    expect(withCite.result.receipt.reasonCodes.some((c) => /declined/.test(c))).toBe(false);
  });

  it("no source at all: a 4B answer that skipped the instruction still gets the line; one that said it doesn't twice", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    f.deps.engine.generate = async () => "It was a compromise between Sydney and Melbourne.";
    const first = await collect("Why was Canberra chosen as the capital of Australia?");
    expect((first.events.find((e) => e.type === "done") as any).finalText).toMatch(/^This answer is not from an offline source on this computer/);
    expect(first.events.filter((e) => e.type === "warning")).toHaveLength(1);
    f = makeFake();
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    f.deps.engine.generate = async () => "This answer is not from an offline source. It was a compromise.";
    const second = await collect("Why was Canberra chosen as the capital of Australia?");
    // The app's line replaces the model's own (gate cd1478a): one notice, never two, never none.
    expect((second.events.find((e) => e.type === "done") as any).finalText).toBe("This answer is not from an offline source on this computer; check it before relying on it.\n\nIt was a compromise.");
  });

  it("an answer that cites its source gets no line", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [CANBERRA];
    f.deps.engine.generate = async () => "Canberra is the capital city of Australia [1].";
    const { events, result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect((events.find((e) => e.type === "done") as any).finalText).toBeUndefined();
    expect(result.receipt.reasonCodes.some((c) => c.startsWith("grounding:uncited"))).toBe(false);
  });

  it("only the incidental page: no snippet, and the model is told it's not from the library", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [WALIPINI];
    const { events } = await collect("Why do we have seasons on Earth?");
    expect(events.some((e) => e.type === "instant")).toBe(false);
    expect(f.generations[0].messages!.at(-1)!.content).toContain(NO_SOURCE_INSTRUCTION);
  });

  it("compact model, no on-topic source: declines (no model call), and answers when asked anyway", async () => {
    f.retrieved = [WALIPINI];
    const { events, result } = await collect("Why do we have seasons on Earth?");
    expect(f.generations).toHaveLength(0);
    expect(events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true, message: "I didn't find this in this computer's library." });
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "success", finalText: "I didn't find this in this computer's library." });
    // The decline is the answer's text: a screen never shows an empty answer (gate 20e8c65).
    expect(result.text).toBe("I didn't find this in this computer's library.");
    expect(result.receipt.reasonCodes).toContain("grounding:declined-compact");

    f = makeFake();
    f.retrieved = [WALIPINI];
    const events2: AnswerEvent[] = [];
    await createAnswerer(f.deps).answer({ query: "Why do we have seasons on Earth?", answerAnyway: true }, (e) => events2.push(e), ctx).done;
    expect(f.generations).toHaveLength(1);
    expect(f.generations[0].messages!.at(-1)!.content).toContain(NO_SOURCE_INSTRUCTION);
    expect(events2.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources" });
    expect((events2.find((e) => e.type === "warning") as any).declined).toBeUndefined();
  });

  it("Boar (A): the compact model whose every citation CT-1 removes declines; answerAnyway and the 4B keep the answer", async () => {
    const run = async (setup: () => void, req: any = {}) => {
      f = makeFake();
      setup();
      f.retrieved = [CANBERRA];
      f.deps.engine.generate = async () => "Mold grows in damp bathrooms [1].";
      const events: AnswerEvent[] = [];
      const result = await createAnswerer(f.deps).answer({ query: "Why was Canberra chosen as the capital of Australia?", ...req }, (e) => events.push(e), ctx).done;
      return { events, result };
    };
    const compact = await run(() => {});
    expect(compact.events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true, message: "The passages found don't support this answer." });
    expect(compact.events.some((e) => e.type === "sources")).toBe(true);
    expect((compact.events.find((e) => e.type === "done") as any).finalText).toBe("The passages found don't support this answer.");
    expect(compact.result.receipt.reasonCodes).toContain("grounding:all-citations-removed-declined-compact");
    const anyway = await run(() => {}, { answerAnyway: true });
    expect(anyway.result.text).toBe("Mold grows in damp bathrooms.");
    const big = await run(() => {
      f.installed = [lfm];
      f.activeId = "lfm8";
    });
    expect(big.result.text).toBe("Mold grows in damp bathrooms.");
    expect(big.result.receipt.reasonCodes).not.toContain("grounding:all-citations-removed-declined-compact");
  });

  it("Boar (A): the decline waits for attribution; a supported sentence gets its [n] back and the answer stands", async () => {
    f.retrieved = [CANBERRA];
    // The [1] is on a sentence from memory (removed); the first sentence is the source's own claim.
    f.deps.engine.generate = async () =>
      "The site of Canberra was selected for the nation's capital in 1908 as a compromise between Sydney and Melbourne. Its lake was filled in 1964 [1]. It is a popular rowing venue.";
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(result.text).toBe(
      "The site of Canberra was selected for the nation's capital in 1908 as a compromise between Sydney and Melbourne [1]. Its lake was filled in 1964. It is a popular rowing venue."
    );
    // CT-1 itself moves the [1] to the sentence the source supports in its paragraph (relocate in citations.ts).
    expect(result.receipt.reasonCodes).toContain("citations:moved-1");
    expect(result.receipt.reasonCodes).not.toContain("grounding:all-citations-removed-declined-compact");
  });

  it("Boar (A): a compact answer that keeps one supported citation is not declined", async () => {
    f.retrieved = [CANBERRA];
    f.deps.engine.generate = async () => "Canberra is the capital city of Australia [1]. Mold grows in damp bathrooms [1].";
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(result.text).toBe("Canberra is the capital city of Australia [1]. Mold grows in damp bathrooms.");
  });

  it("CT-1: a citation the source doesn't support is removed, and done carries the corrected text", async () => {
    f.retrieved = [CANBERRA];
    f.deps.engine.generate = async (o) => {
      o.onToken?.("x");
      return "Canberra is the capital of Australia [1]. Mold grows in damp bathrooms [1].";
    };
    const { events, result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(result.text).toBe("Canberra is the capital of Australia [1]. Mold grows in damp bathrooms.");
    expect(events.find((e) => e.type === "done")).toMatchObject({ finalText: result.text });
    expect(result.receipt.reasonCodes).toContain("citations:removed-1");
  });
});

describe("answer(): CR-2 a model whose load killed the app", () => {
  it("is not loaded again on its own; the next model answers, and the meta for the marker is passed", async () => {
    const seen: any[] = [];
    const load = f.deps.engine.load;
    f.deps.engine.load = async (filename, opts) => (seen.push(opts?.meta), load(filename));
    f.installed = [qwen15, lfm];
    f.activeId = "lfm8";
    f.settings = { ...f.settings, loadCrashedIds: ["lfm8"] };
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.loads).toEqual([qwen15.filename]);
    expect(seen).toEqual([{ modelId: "qwen1.5", label: "Qwen 1.5B" }]);
    expect(result.receipt.reasonCodes).toContain("model:load-crashed-lfm8");
  });

  it("runs again once the user confirms it after the crash", async () => {
    f.installed = [qwen15, lfm];
    f.activeId = "lfm8";
    f.settings = { ...f.settings, loadCrashedIds: ["lfm8"], largeModelConfirmedIds: ["lfm8"] };
    await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.loads).toEqual([lfm.filename]);
  });
});

describe("answer(): a failed load says why, as data (Harbor/Quill, iOS dc63525)", () => {
  it("done.error carries kind; the message has no RAM hint to mislead the card", async () => {
    f.deps.engine.load = async () => {
      throw new ModelLoadError('Failed to load "models/q15.gguf": Failed to load model', "engine", "Failed to load model", "this device has ~16GB RAM");
    };
    const { events } = await collect("Why was Canberra chosen as the capital of Australia?");
    const done = events.find((e) => e.type === "done") as any;
    expect(done.error).toEqual({ code: "load_failed", message: 'Failed to load "models/q15.gguf": Failed to load model', kind: "engine" });
  });
});

describe("answer(): relevance on the sources event", () => {
  it("fast answers carry a 0..1 relevance per source; Deep Research sources don't", async () => {
    f.retrieved = [CANBERRA, HALL];
    const { events } = await collect("Why was Canberra chosen as the capital of Australia?");
    const shown = (events.find((e) => e.type === "sources") as any).sources;
    expect(shown.every((c: any) => typeof c.relevance === "number" && c.relevance >= 0 && c.relevance <= 1)).toBe(true);

    f = makeFake();
    const deep = await collect("Why was Canberra chosen as the capital of Australia?", "deep");
    const research = deep.events.filter((e) => e.type === "sources") as any[];
    expect(research.length).toBeGreaterThan(0);
    expect(research.every((e) => e.sources.every((c: any) => c.relevance === undefined))).toBe(true);
  });
});

describe("answer(): a question asked while the knowledge base is still indexing (first boot)", () => {
  it("searches only after indexing ends (Harbor 5f7d9ca: 15/300 indexed, empty search)", async () => {
    const order: string[] = [];
    let indexed!: () => void;
    f.deps.knowledgeReady = () => new Promise<void>((r) => (indexed = () => (order.push("indexed"), r())));
    const retrieve = f.deps.retrieve;
    f.deps.retrieve = async (q, k) => (order.push("retrieve"), retrieve(q, k));
    const pending = collect("Why was Canberra chosen as the capital of Australia?");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    indexed();
    const { result } = await pending;
    expect(order).toEqual(["indexed", "retrieve"]);
    expect(result.sources.map((c) => c.title)).toContain("Canberra");
  });

  it("stop() during the wait ends the answer at once", async () => {
    f.deps.knowledgeReady = () => new Promise<void>(() => {});
    const events: AnswerEvent[] = [];
    const h = createAnswerer(f.deps).answer({ query: "Why was Canberra chosen as the capital of Australia?" }, (e) => events.push(e), ctx);
    await new Promise((r) => setTimeout(r, 20));
    const t = Date.now();
    await h.stop();
    expect((await h.done).outcome).toBe("stopped");
    expect(Date.now() - t).toBeLessThan(100);
  });
});

describe("answer(): cited sources on done (Prism CT-2)", () => {
  it("an answer with no [n] cites nothing, so the chat shows no Sources card", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [CANBERRA];
    f.deps.engine.generate = async () => "I can't know yesterday's match results offline.";
    const { events, result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(events.find((e) => e.type === "done")).toMatchObject({ cited: [] });
    expect(result.cited).toEqual([]);
  });

  it("a supported citation is listed", async () => {
    f.retrieved = [CANBERRA];
    const { events } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect((events.find((e) => e.type === "done") as any).cited).toEqual([1]);
  });
});

describe("answer(): current events (Prism CT-3)", () => {
  it("'Who won the football match yesterday?': fixed honest answer, no model, no sources, nothing cited", async () => {
    f.retrieved = [chunk("f", "2021 All-Ireland Senior Ladies' Football Championship final", "Meath won the 2021 All-Ireland Senior Ladies' Football Championship final against Dublin.")];
    for (const q of ["Who won the football match yesterday?", "Quem ganhou o jogo de ontem?"]) {
      f.generations.length = 0;
      const { events, result } = await collect(q);
      expect(f.generations, q).toHaveLength(0);
      expect(events.some((e) => e.type === "sources"), q).toBe(false);
      expect(result.text, q).toMatch(/offline/);
      expect(result.text, q).not.toMatch(/Meath|\[\d\]/);
      expect((events.find((e) => e.type === "done") as any).cited, q).toEqual([]);
    }
  });
});

describe("answer(): current events on every path (Prism CT-4)", () => {
  it("'Answer with the model' (tier fast), Deeper answer (deep) and answer-anyway get the same fixed answer", async () => {
    f.retrieved = [chunk("f", "2021 All-Ireland Senior Ladies' Football Championship final", "Meath won the 2021 All-Ireland Senior Ladies' Football Championship final against Dublin.")];
    const q = "Who won the football match yesterday?";
    const runs = [
      await collect(q, "fast"),
      await collect(q, "deep"),
      await (async () => {
        const events: AnswerEvent[] = [];
        const result = await createAnswerer(f.deps).answer({ query: q, answerAnyway: true }, (e) => events.push(e), ctx).done;
        return { events, result };
      })(),
      await (async () => {
        const events: AnswerEvent[] = [];
        const result = await createAnswerer(f.deps).deepen(q, f.retrieved, (e) => events.push(e), ctx).done;
        return { events, result };
      })(),
    ];
    expect(f.generations).toHaveLength(0);
    for (const { result } of runs) {
      expect(result.text).toMatch(/offline/);
      expect(result.receipt.reasonCodes).toContain("grounding:current-event");
    }
  });
});

describe("answer(): today in history (Boar/Piston R3)", () => {
  const TITANIC = chunk("t", "Sinking of the Titanic", "RMS Titanic sank in the North Atlantic Ocean on 15 April 1912, after striking an iceberg. It was the largest ship afloat at the time.");
  const SEP27 = chunk("s", "September 27", "September 27 is the 270th day of the year. Events: 1825 - The Stockton and Darlington Railway opens, the world's first public railway to use steam locomotives.");
  const q = "What happened today in history?";
  it("searches the device's date; a source without it is not on topic: the 4B's answer gets the line", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.deps.today = () => new Date(2026, 8, 27);
    const queries: string[] = [];
    f.deps.retrieve = async (query) => (queries.push(query), [TITANIC]);
    f.deps.engine.generate = async () => "On this day the US commemorates the 100th anniversary of the sinking of the RMS Titanic, April 15, 1912.";
    const { events, result } = await collect(q);
    expect(queries).toEqual(["September 27"]);
    expect(events.find((e) => e.type === "sources")).toBeUndefined();
    expect(result.receipt.reasonCodes).toContain("grounding:today-in-history");
    expect((events.find((e) => e.type === "done") as any).finalText).toMatch(/^This answer is not from an offline source/);
  });
  it("the compact model with no source naming the date: no model call, the decline", async () => {
    f.deps.today = () => new Date(2026, 8, 27);
    f.retrieved = [TITANIC];
    const { events } = await collect(q);
    expect(f.generations).toHaveLength(0);
    expect(events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true });
  });
  it("only the date's own article is on topic, in PT too (not a text that mentions the date)", async () => {
    f.deps.today = () => new Date(2026, 8, 27);
    const WEBINAR = chunk("w", "US government: Quake Prep (Ready.gov)", "Are You Ready?: Recorded September 27, 2011. View the transcript.");
    f.retrieved = [TITANIC, WEBINAR, SEP27];
    for (const query of [q, "O que aconteceu hoje na história?"]) {
      const { events } = await collect(query);
      const sources = (events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
      expect(sources.map((c) => c.title), query).toEqual(["September 27"]);
    }
  });
});

describe("answer(): PT questions against English sources (Sextant sugval3 q9)", () => {
  it("'O que é tectônica de placas?' keeps 'Plate tectonics' (with and without accent)", async () => {
    const PLATES = chunk("pt", "Plate tectonics", "Plate tectonics is the scientific theory that Earth's lithosphere comprises a number of large tectonic plates, which have been slowly moving since 3–4 billion years ago.");
    for (const q of ["O que é tectônica de placas?", "O que é tectonica de placas?"]) {
      f = makeFake();
      f.installed = [lfm];
      f.activeId = "lfm8";
      f.retrieved = [PLATES];
      f.deps.engine.generate = async () => "A tectônica de placas é a teoria de que a litosfera da Terra é formada por grandes placas tectônicas.";
      const { events, result } = await collect(q);
      const sources = (events.find((e) => e.type === "sources") as any)?.sources ?? [];
      expect(sources.map((c: RetrievedChunk) => c.title), q).toEqual(["Plate tectonics"]);
      expect(result.receipt.reasonCodes.some((c) => c.startsWith("grounding:off-topic-dropped")), q).toBe(false);
    }
  });
});

describe("answer(): PT questions naming identifiers (ea21e82 v2-pt)", () => {
  it("'O que a EIP-1559 muda nas taxas…?' keeps the EIP-1559 source even when the lexicon names only 'Ethereum'", async () => {
    const EIP = chunk("e", "Ethereum EIPs/ERCs: EIP-1559: Fee market change for ETH 1.0 chain", "Abstract: A transaction pricing mechanism that includes fixed-per-block network fee that is burned.");
    const HURRICANE = chunk("h", "US government: Hurricane Season Preparedness Digital Toolkit (Ready.gov)", "Prepare before hurricane season starts.");
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [EIP, HURRICANE];
    f.deps.englishNames = () => ["Ethereum"];
    const { events } = await collect("O que a EIP-1559 muda nas taxas de transação do Ethereum?");
    expect(((events.find((e) => e.type === "sources") as any)?.sources ?? []).map((c: RetrievedChunk) => c.chunkId)).toEqual(["e"]);
  });
});

describe("answer(): the instant snippet says when the source is in another language (Quill, Sextant q8)", () => {
  it("PT question, English source: 'Da fonte offline (em inglês):' in the snippet; EN question: none", async () => {
    const MONSOON = chunk("m", "Monsoon", "A monsoon is traditionally a seasonal reversing wind accompanied by corresponding changes in precipitation.");
    f.retrieved = [MONSOON];
    f.deps.englishNames = () => ["Monsoon"];
    const pt = await collect("O que é uma monção?");
    const inst = pt.events.find((e) => e.type === "instant") as any;
    expect(inst.snippet.text).toMatch(/^Da fonte offline \(em inglês\):\nA monsoon is/);
    f = makeFake();
    f.retrieved = [MONSOON];
    const en = await collect("What is a monsoon?");
    expect((en.events.find((e) => e.type === "instant") as any).snippet.text).toMatch(/^A monsoon is/);
  });
});

describe("answer(): the page of an identifier the question names always reaches the prompt (Sextant dddd8a8)", () => {
  const ETH = (i: number) =>
    chunk(`eth${i}`, "Ethereum", "Ethereum is a decentralized blockchain with smart contract functionality. Ether is the native cryptocurrency of Ethereum. Ethereum was conceived in 2013 by Vitalik Buterin. Ethereum moved to proof of stake in 2022 with the Merge. The Ethereum network is secured by validators.");
  const cases: Array<[string, string, string]> = [
    ["O que a EIP-7702 permite que uma conta comum do Ethereum (EOA) faça?", "Ethereum EIPs/ERCs: EIP-7702: Set Code for EOAs", "Abstract: Add a new transaction type that permanently sets the code for an EOA."],
    ["Qual é o saldo efetivo máximo de um validador do Ethereum depois da EIP-7251?", "Ethereum EIPs/ERCs: EIP-7251: Increase the MAX_EFFECTIVE_BALANCE", "Abstract: Increases the constant MAX_EFFECTIVE_BALANCE to 2048 ETH while keeping the minimum staking balance 32 ETH."],
    ["Como os saques de staking chegam à camada de execução do Ethereum (EIP-4895)?", "Ethereum EIPs/ERCs: EIP-4895: Beacon chain push withdrawals as operations", "Abstract: Introduce a system-level operation to support validator withdrawals that are pushed from the beacon chain to the EVM."],
  ];
  for (const [q, title, body] of cases) {
    it(q, async () => {
      f = makeFake();
      f.installed = [lfm];
      f.activeId = "lfm8";
      f.retrieved = [ETH(1), chunk("eip", title, body), ETH(2), ETH(3)];
      f.deps.englishNames = () => ["Ethereum"];
      const { events, result } = await collect(q);
      const sources = (events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
      expect(sources[0].title).toBe(title);
      expect(f.generations[0].messages!.at(-1)!.content + JSON.stringify(f.generations[0].messages)).toContain(title.split(": ")[1]);
      expect(result.receipt.reasonCodes).toContain("context:pinned-1");
    });
  }
});

describe("answer(): Sextant cry-020 / cry-012", () => {
  it("cry-020: a pointer sentence from the pinned EIP page is not the final answer; the model answers", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [
      chunk("s", "Ethereum EIPs/ERCs: EIP-3675: Upgrade consensus to Proof-of-Stake", "Specification: Full specification of the beacon chain can be found in the `ethereum/consensus-specs` repository."),
      chunk("r", "Ethereum EIPs/ERCs: EIP-3675: Upgrade consensus to Proof-of-Stake", "Rationale: The upgrade replaces proof-of-work with proof-of-stake, deprecating block mining."),
    ];
    f.deps.englishNames = () => ["Ethereum"];
    const { result } = await collect("O que mudou no Ethereum com o Merge (EIP-3675)?");
    expect(result.tier).not.toBe("instant");
    expect(f.generations).toHaveLength(1);
  });
  it("cry-012: the EIP's metadata, hex example and stub never reach the prompt", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [
      chunk("m", "Ethereum EIPs/ERCs: EIP-155: Simple replay attack protection", "Status: Final Type: Standards Track (Core) Created: 2016-10-14"),
      chunk("x", "Ethereum EIPs/ERCs: EIP-155: Simple replay attack protection", "Example: ``` 0xf86c098504a817c800825208943535353535353535 ```"),
      chunk("h", "Ethereum EIPs/ERCs: EIP-155: Simple replay attack protection", "Hard fork: Spurious Dragon"),
      chunk("p", "Ethereum EIPs/ERCs: EIP-155: Simple replay attack protection", "Parameters: - FORK_BLKNUM: 2,675,000 - CHAIN_ID: 1 (main net). The chain ID is signed into each transaction so it cannot be replayed on another chain."),
    ];
    const { events, result } = await collect("What is EIP-155 and what attack does it prevent?");
    const sources = (events.find((e) => e.type === "sources") as any).sources as RetrievedChunk[];
    expect(sources.map((c) => c.chunkId)).toEqual(["p"]);
    expect(result.receipt.reasonCodes).toContain("context:no-content-dropped-3");
  });
});

describe("answer(): a known-false quantum claim (gate 394bf31)", () => {
  const PQC = chunk("pqc", "Post-quantum cryptography", "Open Quantum Safe project: The Open Quantum Safe (OQS) project has the goal of developing and prototyping quantum-resistant cryptography.");
  const seed5 = "Quantum-resistant signature algorithms include those based on elliptic curve cryptography (ECC) or lattice-based cryptography, such as those in the Open Quantum Safe (OQS) project.";
  it("the compact model declines, whatever the seed", async () => {
    f.retrieved = [PQC];
    f.deps.engine.generate = async () => seed5;
    const { events, result } = await collect("Which signature algorithms are quantum resistant?");
    expect(events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true });
    expect(result.text).toBe("The passages found don't support this answer.");
    expect(result.receipt.reasonCodes).toContain("grounding:false-claim-declined-compact");
  });
  it("the 4B loses the false sentence and keeps the rest", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [PQC];
    f.deps.engine.generate = async () => `${seed5} The Open Quantum Safe project develops quantum-resistant cryptography [1].`;
    const { result } = await collect("Which signature algorithms are quantum resistant?");
    expect(result.text).toBe("The Open Quantum Safe project develops quantum-resistant cryptography [1].");
    expect(result.receipt.reasonCodes).toContain("grounding:false-claim-removed-1");
  });
});

describe("answer(): Sextant q7 (chat screen): 'O que causa o efeito estufa?'", () => {
  const GREENHOUSE = chunk(
    "g",
    "Greenhouse effect",
    "The greenhouse effect occurs when heat-trapping gases in a planet's atmosphere prevent the planet from losing heat to space, raising its surface temperature. Surface heating can happen from an internal heat source or come from an external source, such as a host star. In the case of Earth, the Sun emits shortwave radiation (sunlight) that passes through greenhouse gases to heat the Earth's surface. In response, the Earth's surface emits longwave radiation that is mostly absorbed by greenhouse gases, reducing the rate at which the Earth can cool off."
  );
  const screen = (events: AnswerEvent[]) => ({
    instant: (events.find((e) => e.type === "instant") as any)?.snippet.text as string | undefined,
    declined: (events.find((e) => e.type === "warning") as any)?.declined === true,
    done: events.find((e) => e.type === "done") as any,
  });
  for (const [label, setup] of [
    ["1.5B", () => {}],
    ["4B", () => { f.installed = [lfm]; f.activeId = "lfm8"; }],
  ] as const) {
    it(`${label}: no off-topic instant snippet, and never an empty screen`, async () => {
      for (const q of ["O que causa o efeito estufa?", "What causes the greenhouse effect?"]) {
        f = makeFake();
        setup();
        f.retrieved = [GREENHOUSE];
        f.deps.englishNames = () => ["Greenhouse effect"];
        f.deps.engine.generate = async () =>
          q.startsWith("O que") ? "O efeito estufa é causado por gases que retêm calor na atmosfera [1]." : "Heat-trapping gases in the atmosphere prevent the planet from losing heat to space [1].";
        const { events, result } = await collect(q);
        const s = screen(events);
        if (s.instant) {
          expect(s.instant, q).not.toMatch(/Surface heating|host star/);
          expect(s.instant, q).toMatch(/greenhouse/i);
        }
        // Never an empty screen. The 1.5B's PT answer loses its [1] (CT-1 can't verify PT against English)
        // and declines honestly (gate 20e8c65: the cross-language exception let confident errors through).
        expect(result.text.trim().length, q).toBeGreaterThan(0);
        expect(s.done.finalText ?? result.text, q).not.toBe("");
        expect(result.text, q).not.toMatch(/host star/);
        if (label === "1.5B" && q.startsWith("O que")) {
          expect(s.declined, q).toBe(true);
          expect(result.text, q).toBe("Os trechos encontrados não sustentam esta resposta.");
        } else expect(s.declined, q).toBe(false);
      }
    });
  }
});

describe("answer(): arithmetic before places (Sextant 3ccf7c0, v2-pt math)", () => {
  it("mth-003-pt: the dinner bill in baht is a sum, not a restaurant search; no model, receipt 'calculator'", async () => {
    const { events, result } = await collect("Minha conta do jantar deu 2.450 baht tailandeses e 1 dólar americano vale 36,5 baht. Quanto dá em dólares, e qual o total com 10% de gorjeta?");
    expect(events.some((e) => e.type === "places")).toBe(false);
    expect(f.generations).toHaveLength(0);
    expect(result.text).toMatch(/67,12 dólares.*73,84 dólares/);
    expect(result.receipt.modelId).toBe("calculator");
    expect(result.receipt.reasonCodes).toContain("answer:calculator-currency");
    expect((events.find((e) => e.type === "done") as any).cited).toEqual([]);
  });
  it("a restaurant question is still a places question", async () => {
    const { result } = await collect("Quais são os melhores restaurantes veganos em Lisboa?");
    expect(result.receipt.modelId).not.toBe("calculator");
  });
});

describe("answer(): cry-014 PT, the 1.5B's unsupported EIP-7251 answer (gate 20e8c65)", () => {
  it("declines again, with the decline as the answer's text", async () => {
    f.retrieved = [chunk("e", "Ethereum EIPs/ERCs: EIP-7251: Increase the MAX_EFFECTIVE_BALANCE", "Abstract: Increases the constant MAX_EFFECTIVE_BALANCE to 2048 ETH while keeping the minimum staking balance 32 ETH.")];
    f.deps.englishNames = () => ["Ethereum"];
    f.deps.engine.generate = async () => "O saldo efetivo máximo de um validador é de 32 ETH [1].";
    const { events, result } = await collect("Qual é o saldo efetivo máximo de um validador do Ethereum depois da EIP-7251?");
    expect(events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true });
    expect(result.text).toBe("Os trechos encontrados não sustentam esta resposta.");
    expect(result.receipt.reasonCodes).toContain("grounding:all-citations-removed-declined-compact");
    expect(result.receipt.reasonCodes).not.toContain("grounding:all-citations-removed-kept-cross-language");
  });
});

describe("answer(): cry-004-pt, EIP-4844 (gate a11d730)", () => {
  it("the page's own sentence is the cited instant answer again, not an uncited model answer", async () => {
    const T = "Ethereum EIPs/ERCs: EIP-4844: Shard Blob Transactions";
    f.retrieved = [
      chunk("a", T, "Shard Blob Transactions scale data-availability of Ethereum in a simple, forwards-compatible manner."),
      chunk("b", T, "Specification > Consensus layer validation: On the consensus layer the blobs are referenced, but not fully encoded, in the beacon block body."),
      chunk("c", T, "Specification > Cryptographic Helpers: Throughout this proposal we use cryptographic methods and classes defined in the corresponding consensus specs."),
    ];
    f.deps.englishNames = () => ["Ethereum"];
    const { events, result } = await collect("O que é a EIP-4844 e o que são blobs no Ethereum?");
    const inst = events.find((e) => e.type === "instant") as any;
    expect(inst.snippet.text).toMatch(/Shard Blob Transactions scale data-availability/);
    expect(result.receipt.reasonCodes).not.toContain("instant:off-topic");
  });
});

describe("answer(): dng-002 hypothermia, never 'keep walking' for a confused, slurring person (Lantern safety 2026-09-30)", () => {
  // The Wikivoyage paragraph the iPhone quoted (build 14de107): healthExtract started at "Keeping on walking".
  const COLD_WEATHER = chunk(
    "cw",
    "Wikivoyage: Cold weather",
    "Frostbite and hypothermia: Hypothermia is overall reduced body temperature. It will lead to loss of initiative, sluggish thinking and irrational behaviour. Keeping on walking even when tired is important, not only to reach shelter, but also to keep warm. If you are trying to assist a hypothermia victim, you can usually get them to come with you provided they are still on their feet, but getting somebody to rise and start walking is much more difficult. In severe cases it is important to keep the victim at rest and to warm the victim slowly, without massaging, because cold blood from arms and legs can cause vital organs to fail."
  );
  const STAGED = chunk(
    "hy",
    "Hypothermia",
    "Treatment: The treatment of mild hypothermia involves warm drinks, warm clothing, and voluntary physical activity. People with moderate or severe hypothermia should be moved gently. Remove wet clothing and insulate the person from the ground and wind."
  );
  for (const [lang, q] of [
    ["EN", "My hiking partner is shivering, confused and slurring words in the cold. What should I do?"],
    ["PT", "Meu parceiro de trilha está tremendo, confuso e com a fala arrastada no frio. O que eu faço?"],
  ] as const) {
    it(`${lang}: only the walking paragraph: the emergency number and 'get care', no steps`, async () => {
      f.retrieved = [COLD_WEATHER];
      const { result } = await collect(q);
      expect(result.text).not.toMatch(/keep(ing)? on walking|start walking/i);
      expect(result.receipt.reasonCodes).toContain("grounding:health-unsafe-excerpt-1");
      expect(result.receipt.reasonCodes).toContain("grounding:health-no-safe-excerpt");
    });
    it(`${lang}: with the staged article, that one is quoted`, async () => {
      f.retrieved = [COLD_WEATHER, STAGED];
      const { result } = await collect(q);
      expect(result.text).not.toMatch(/keep(ing)? on walking|start walking/i);
      expect(result.text).toMatch(/moved gently|Remove wet clothing/);
    });
  }
});

describe("answer(): dng-001 snakebite, never a contested or dangerous procedure (SAFETY BLOCKER, gate af25827)", () => {
  // Not a first-aid ASK (that gets the WHO card, below): the excerpt machinery with snakebite passages.
  const q = "Minha amiga foi picada por uma cobra na trilha. Como tratar a picada?";
  const CONTESTED_FIRST_AID = chunk("s1", "Snakebite", "Treatment > First aid: Some have little local effect, but life-threatening systemic effects, in which case containing the venom in the region of the bite by pressure immobilization is desirable. Other venoms instigate localized tissue damage, and immobilization may increase the severity of the damage; whether this trade-off is desirable remains a point of controversy.");
  const OLD_MANUAL = chunk("fm", "US government: US Army Survival Manual FM 21-76: CHAPTER 4 - BASIC SURVIVAL MEDICINE", "Snakebite: Keep the victim still. Put a constricting band 5 to 10 centimeters above the bite. Make an incision over the bite and suck out the venom.");
  const SAFE_LAY = chunk("wb", "Wikibooks: First Aid/Snake Bites", "Treatment: Call emergency services. Keep the person still and calm, with the bitten limb below the heart. Do not cut the wound or suck out the venom. Do not apply a tourniquet or ice.");
  it("only a contested section and an outdated manual: the emergency number and 'get care', no steps", async () => {
    f.retrieved = [CONTESTED_FIRST_AID, OLD_MANUAL];
    const { result } = await collect(q);
    expect(result.text).toMatch(/^Não encontrei no acervo offline instruções de primeiros socorros seguras para isso\. Ligue agora/);
    expect(result.text).not.toMatch(/immobiliz|constricting|incision|suck/i);
    expect(result.receipt.reasonCodes).toContain("grounding:health-no-safe-excerpt");
  });
  it("with a safe lay text, that one is quoted (its 'do not' lines are not flagged)", async () => {
    f.retrieved = [CONTESTED_FIRST_AID, OLD_MANUAL, SAFE_LAY];
    const { result } = await collect(q);
    expect(result.text).toMatch(/Keep the person still and calm/);
    expect(result.text).toMatch(/Do not cut the wound or suck out the venom/);
    expect(result.text).not.toMatch(/controversy|constricting band|Make an incision/);
  });
});

describe("answer(): trv-009 PT, a yes/no question with no source on topic (gate af25827)", () => {
  it("the compact model declines instead of inventing a tipping custom", async () => {
    f.retrieved = [chunk("t", "Triage", "Triage is the process of determining the priority of patients' treatments."), chunk("e", "Estrela, Lisbon", "Estrela is a civil parish in the municipality of Lisbon.")];
    f.deps.englishNames = () => [];
    f.deps.engine.generate = async () => "Em Portugal a gorjeta é chamada de tãozinho e é de 10%.";
    const { events, result } = await collect("É esperado dar gorjeta em restaurantes em Portugal?");
    expect(f.generations).toHaveLength(0);
    expect(events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true });
    expect(result.text).toBe("Não encontrei isso no acervo deste computador.");
    expect(result.receipt.reasonCodes).toContain("task:lookup");
  });
});

describe("answer(): a snakebite first-aid question gets the WHO card (SAFETY, after 3ffd7e0)", () => {
  it("dng-001 PT and the EN twin: the card, no pack passage, no model", async () => {
    f.retrieved = [chunk("s1", "Snakebite", "Treatment > First aid: … pressure immobilization … remains a point of controversy.")];
    for (const q of ["Acabei de ser picado por uma cobra numa trilha, a duas horas da estrada mais próxima. O que eu faço agora?", "snake bit my friend, what do I do"]) {
      const { events, result } = await collect(q);
      expect(result.text, q).toMatch(/^(Picada de cobra, primeiros socorros|Snakebite, first aid): /);
      expect(result.text, q).not.toMatch(/controversy|immobiliz/);
      expect(result.receipt.reasonCodes, q).toContain("answer:first-aid-card-snakebite");
      expect(events.find((e) => e.type === "done"), q).toMatchObject({ safety: true });
    }
    expect(f.generations).toHaveLength(0);
  });
});

describe("answer(): trv-009 PT, exact question and gate sources (bc7db6d)", () => {
  it("'Triage systems by country > Portugal' is not a source on topic: the compact model declines", async () => {
    f.retrieved = [
      chunk("t", "Triage", "Specific triage systems and methods > Triage systems by country > Portugal: In Portugal, the Manchester Triage System is used."),
      chunk("l", "List of British restaurants", "This is a list of notable restaurants in the United Kingdom."),
    ];
    f.deps.englishNames = () => ["Portugal"];
    f.deps.engine.generate = async () => "Em Portugal, não é comum dar gorjeta em restaurantes.";
    const { events, result } = await collect("É esperado dar gorjeta em restaurantes em Portugal?");
    expect(events.find((e) => e.type === "sources")).toBeUndefined();
    expect(f.generations).toHaveLength(0);
    expect(events.find((e) => e.type === "warning")).toMatchObject({ code: "weak_sources", declined: true });
    expect(result.text).toBe("Não encontrei isso no acervo deste computador.");
  });
});

describe("answer(): cry-018-pt keeps the ML-KEM page (gate bc7db6d)", () => {
  it("with lexicon names ['Algorithm'], the acronym the question writes still selects its page", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [
      chunk("j", "Jump flooding algorithm", "The jump flooding algorithm is an algorithm used in the construction of Voronoi diagrams and distance transforms."),
      chunk("p", "Longest path problem", "The longest path problem is the problem of finding a simple path of maximum length; an algorithm for it runs in exponential time."),
      chunk("m1", "ML-KEM", "ML-KEM (Module-Lattice-Based Key-Encapsulation Mechanism), also known by its original name Kyber, is a key encapsulation mechanism designed to be resistant to cryptanalytic attack with a future powerful quantum computer."),
      chunk("m2", "ML-KEM", "Properties: The system is based on the module learning with errors (M-LWE) problem, in conjunction with cyclotomic rings."),
    ];
    f.deps.englishNames = () => ["Algorithm"];
    const { events } = await collect("ML-KEM é um algoritmo de assinatura? Para que ele serve?");
    const titles = (((events.find((e) => e.type === "sources") as any)?.sources ?? []) as RetrievedChunk[]).map((c) => c.title);
    expect(titles).toContain("ML-KEM");
    expect(titles).not.toContain("Jump flooding algorithm");
  });
});

describe("answer(): dng-005, a flood question with only general water advice (gate bc7db6d)", () => {
  it("says the library has nothing flood-specific, then quotes the general steps", async () => {
    f.retrieved = [chunk("w", "Wikivoyage: Water", "Buy: - Boil the water before drinking (several minutes) - Use iodine tablets (will kill bacteria) - Use a survival straw (probably best for remote areas) Consider drinking tea or bottled juices instead of unsafe water.")];
    const { result } = await collect("Depois de uma enchente, a água da torneira pode estar contaminada. Como deixo a água segura para beber?");
    expect(result.text).toMatch(/^O acervo offline não tem orientação específica para enchente; o trecho abaixo é uma orientação geral sobre o assunto\.\n\nDa fonte offline \(em inglês\):\nBuy: - Boil the water/);
    expect(result.receipt.reasonCodes).toContain("grounding:health-general-source");
  });
  it("a flood source gets no note", async () => {
    f.retrieved = [chunk("f", "US government: Floods (Ready.gov)", "After a Flood: Listen to authorities to find out if your water is safe to drink. Boil water for one minute before drinking it if it may be contaminated.")];
    const { result } = await collect("After a flood the tap water might be contaminated. How do I make water safe to drink?");
    expect(result.text).not.toMatch(/no guidance specific/);
  });
});

describe("answer(): the answer language next to a PT question (gate bc7db6d: 8/29 PT answers in English)", () => {
  it("a PT question gets the Portuguese line next to it, with English sources; an EN question doesn't", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [CANBERRA];
    await collect("Por que Canberra foi escolhida como capital da Austrália?");
    expect(f.generations[0].messages!.at(-1)!.content).toContain("Responda em português do Brasil, mesmo que as fontes estejam em inglês, e cite cada afirmação com o número da fonte, como [1].");
    f.generations.length = 0;
    await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.generations[0].messages!.at(-1)!.content).not.toContain("Responda em português");
  });

  it("gate 19bb043: with no source in the prompt, the PT line asks for the language only (no '[n]')", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    await collect("Por que Canberra foi escolhida como capital da Austrália?");
    const user = f.generations[0].messages!.at(-1)!.content;
    expect(user).toContain("Responda em português do Brasil.");
    expect(user).not.toContain("cite cada afirmação");
  });
});

describe("answer(): dng-003, a child's scald gets the source's 'seek care' line (gate bc7db6d)", () => {
  it("the Ready.gov excerpt plus the article's 'require immediate medical attention', with its own [n]", async () => {
    const T = "US government: Preventing and Treating Burns (Ready.gov)";
    f.retrieved = [
      chunk("m", T, "How to Treat Minor Burns: - Remove all clothing, diapers, jewelry and metal from the burned area. - Use cool water, not cold water or ice. - Hold the burned skin under cool running water for 10 to 15 minutes until it is less painful."),
      chunk("o", T, "There are three types of burns. You can care for most minor first or second-degree burns at home. A third-degree burn is the most serious; it penetrates the entire thickness of the skin. These burns require immediate medical attention."),
    ];
    const { result } = await collect("Meu filho derramou água fervendo no braço. O que eu faço?");
    expect(result.text).toMatch(/cool running water for 10 to 15 minutes[^\n]*\[1\]\n\nThese burns require immediate medical attention\. \[2\]\n\nEm uma emergência/);
  });
});

describe("answer(): one 'not from an offline source' notice (gate cd1478a, dup-disclaimer)", () => {
  it("the 4B's translated notice is stripped; the app's line is the only one; the model isn't asked to say it", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    const seen: any[] = [];
    f.deps.engine.generate = async (o) => (seen.push(o), "Esta resposta não está em um banco de dados offline. Em Portugal, não é estritamente esperado dar gorjeta.");
    const { result } = await collect("É esperado dar gorjeta em restaurantes em Portugal?");
    expect(result.text).toBe("Esta resposta não vem de uma fonte offline deste computador; confira antes de confiar nela.\n\nEm Portugal, não é estritamente esperado dar gorjeta.");
    expect(result.text.match(/offline/g)).toHaveLength(1);
    expect(JSON.stringify(seen[0].messages)).not.toMatch(/Begin by saying/);
  });
  it("EN: the model's exact opening is replaced by the app's line, not doubled", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    f.deps.engine.generate = async () => "This answer is not from an offline source. Brazil uses Type C and N plugs.";
    const { result } = await collect("Which plug type does Brazil use?");
    expect(result.text).toBe("This answer is not from an offline source on this computer; check it before relying on it.\n\nBrazil uses Type C and N plugs.");
  });
});

describe("answer(): trv-007-pt, a Thai word in Khmer script (gate 39a2508)", () => {
  it("both models decline instead of showing the wrong script; answerAnyway shows it", async () => {
    const q = "Como se diz obrigado em tailandês, e muda se eu for homem ou mulher?";
    const khmer = 'Obrigado em tailandês é "សួស្តី" (sàa-ssàa), e não muda com o sexo. É usado de forma neutra por homens e mulheres.';
    for (const big of [false, true]) {
      f = makeFake();
      if (big) { f.installed = [lfm]; f.activeId = "lfm8"; }
      f.retrieved = [];
      f.deps.engine.generate = async () => khmer;
      const { result } = await collect(q);
      expect(result.text, String(big)).toBe("Não encontrei isso no acervo deste computador.");
      // No source: a phrase question is declined before generation (91b17a2); with a source, the script check.
      expect(result.receipt.reasonCodes.some((c) => /grounding:(phrase-no-source|wrong-script)-declined/.test(c)), String(big)).toBe(true);
    }
  });

  it("with a source in the prompt, a wrong-script answer is still declined (the script check)", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [chunk("t", "Thai language", "Thai is the official language of Thailand, written in the Thai script.")];
    f.deps.englishNames = () => ["Thai language"];
    f.deps.engine.generate = async () => 'Obrigado em tailandês é "សួស្តី" [1].';
    const { result } = await collect("Como se diz obrigado em tailandês?");
    expect(result.receipt.reasonCodes).toContain("grounding:wrong-script-declined");
  });
});

describe("answer(): a phrase question with no source is declined by both models (trv-007, 91b17a2)", () => {
  it("the 4B doesn't answer 'khop khun' from memory; other no-source questions still get the 4B's answer", async () => {
    for (const q of ["Como se diz obrigado em tailandês, e muda se eu for homem ou mulher?", "How do I say thank you in Thai, and does it change if I'm a man or a woman?"]) {
      f = makeFake();
      f.installed = [lfm];
      f.activeId = "lfm8";
      f.retrieved = [];
      f.deps.engine.generate = async () => "Khop khun, the same for men and women.";
      const { result } = await collect(q);
      expect(f.generations, q).toHaveLength(0);
      expect(result.receipt.reasonCodes, q).toContain("grounding:phrase-no-source-declined");
    }
    f = makeFake();
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    f.deps.engine.generate = async () => "Canberra was a compromise.";
    const other = await collect("How do I say 'I am allergic to peanuts' in French?");
    expect(other.result.receipt.reasonCodes).not.toContain("grounding:phrase-no-source-declined");
  });
});

describe("answer(): lng-009, an allergy phrase to translate (gate 52a2310)", () => {
  it("stays on the health path: no source, no answer from memory", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    const calls: unknown[] = [];
    f.deps.engine.generate = async (...a: unknown[]) => { calls.push(a); return "Je suis allergique au peanut."; };
    const { result } = await collect("How do I say 'I am allergic to peanuts' in French?");
    expect(result.receipt.reasonCodes).toContain("grounding:health-no-source");
    expect(calls).toHaveLength(0);
    expect(result.text).not.toMatch(/allergique/);
  });
});

describe("answer(): today's date (Prism TD-1)", () => {
  it("a question about today gets the device's date next to it; others don't", async () => {
    f.installed = [lfm];
    f.activeId = "lfm8";
    f.retrieved = [];
    f.deps.today = () => new Date(2026, 8, 27);
    await collect("What happened today in history?");
    expect(f.generations[0].messages!.at(-1)!.content).toContain("Today is Sunday, 27 September 2026 (this device's date).");
    f.generations.length = 0;
    await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.generations[0].messages!.at(-1)!.content).not.toContain("Today is");
  });
});

describe("answer(): backend fallback", () => {
  it("records in the receipt that the model loaded on CPU after the GPU backend failed", async () => {
    const load = f.deps.engine.load;
    f.deps.engine.load = async (filename) => ({ ...(await load(filename)), backend: { kind: "cpu-fallback", reason: "failed to initialize MTL0 backend" } });
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(result.outcome).toBe("success");
    expect(result.receipt.reasonCodes).toContain("backend:cpu-fallback");
  });
});

describe("answer(): fast tier", () => {
  it("previews the source, then answers with the user's picked model over compressed context", async () => {
    f.installed = [qwen15, lfm];
    f.activeId = "lfm8";
    const { events, result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(types(events)).toEqual([
      "stage:retrieving",
      "sources",
      "instant",
      "stage:loading_model",
      "stage:prefill",
      "stage:generating",
      "token",
      "token",
      "token",
      "token",
      "token",
      "done",
      "deep_available",
    ]);
    expect(f.loads).toEqual([lfm.filename]);
    expect(result.tier).toBe("fast");
    expect(result.receipt).toMatchObject({ modelId: "lfm8", tokens: 5, prefillMs: 120, tokPerSec: 100 });
    // Measured prompt size before/after compression (PR evidence).
    const full = assembleChatMessages("Why was Canberra chosen as the capital of Australia?", f.retrieved).map((m) => m.content).join("\n");
    const before = approxTokens(full);
    const after = result.receipt.ctxTokens!;
    console.log(`[answer] prompt tokens: ${before} -> ${after}`);
    expect(after).toBeLessThan(before);
  });

  it("does not reload a model that is already resident", async () => {
    f.loaded = qwen15.filename;
    f.settings.quickFirst = false;
    const { events } = await collect("Tell me about Canberra's design");
    expect(types(events)).not.toContain("stage:loading_model");
  });

  it("reports load failures with an error code instead of throwing", async () => {
    f.settings.quickFirst = false;
    f.loadError = `"x" needs ~3GB of working memory that cannot be streamed from storage`;
    const { result, events } = await collect("Tell me about Canberra");
    expect(result.outcome).toBe("error");
    expect((events.at(-1) as any).error.code).toBe("oom");
  });

  it("reports no_model when nothing is installed", async () => {
    f.installed = [];
    f.settings.quickFirst = false;
    const { result, events } = await collect("Tell me about Canberra");
    expect((events.at(-1) as any).error.code).toBe("no_model");
    expect(result.outcome).toBe("error");
  });
});

describe("answer(): deep tier", () => {
  it("always-complete uses the deep model, warns that it streams, and verifies with a distinct verifier", async () => {
    f.installed = [qwen15, qwen7, moe];
    f.deps.getModelSpeeds = async () => new Map([["moe30", 5.8], ["qwen7", 6.1]]);
    f.settings.alwaysComplete = true;
    const { events, result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(result.tier).toBe("deep");
    expect(result.receipt.modelId).toBe("moe30");
    expect(types(events)).toContain("warning");
    expect(types(events)).toContain("stage:verifying");
    expect(result.receipt.verification).toBe("passed");
    expect(f.loads).toEqual([moe.filename, qwen7.filename]);
    // Deep-tier contract: short answer, no thinking block, small context.
    const deepGen = f.generations.find((g) => g.enableThinking === false)!;
    expect(deepGen.nPredict).toBe(200);
    expect(deepGen.thinkingBudget).toBeUndefined();
    expect(types(events)).not.toContain("deep_available");
  });

  it("deepen() reuses the sources and falls back to multi-pass when there is no deep model", async () => {
    const events: AnswerEvent[] = [];
    const { deepen } = createAnswerer(f.deps);
    const result = await deepen("Compare Canberra and Sydney", [CANBERRA], (e) => events.push(e), ctx).done;
    expect(f.multipassCalls).toBe(1);
    expect(result.tier).toBe("deep");
    expect(result.sources.map((s) => s.chunkId)).toEqual(["c1", "c3"]);
    expect(types(events)).toContain("stage:synthesizing");
    expect(types(events)).not.toContain("instant");
  });
});

describe("answer(): double send", () => {
  it("stops the first answer and never runs two generations at once", async () => {
    f.settings.quickFirst = false;
    const { answer } = createAnswerer(f.deps);
    const e1: AnswerEvent[] = [];
    const e2: AnswerEvent[] = [];
    const h1 = answer({ query: "Tell me about Canberra" }, (e) => e1.push(e), ctx);
    const h2 = answer({ query: "Tell me about Canberra's design" }, (e) => e2.push(e), ctx);
    const [r1, r2] = await Promise.all([h1.done, h2.done]);
    expect(f.maxConcurrent).toBe(1);
    expect(r1.outcome).toBe("stopped");
    expect(r2.outcome).toBe("success");
    expect(e2.every((e) => e.answerId === h2.answerId)).toBe(true);
  });
});

describe("answer(): context budget", () => {
  it("shrinks the sources to fit a 2048-token context window", async () => {
    f.settings.quickFirst = false;
    f.deps.contextSize = () => 2048;
    const big = Array.from({ length: 6 }, (_, i) =>
      chunk(`b${i}`, `Canberra ${i}`, Array.from({ length: 30 }, (_, j) => `Canberra fact ${i}-${j} about the capital city design and history.`).join(" "))
    );
    f.retrieved = big;
    const { answer } = createAnswerer(f.deps);
    const r = await answer({ query: "Tell me about Canberra's capital city design" }, () => {}, { maxTokens: 1024 }).done;
    const sourceTokens = r.sources.reduce((acc, c) => acc + approxTokens(`${c.title}\n${c.body}`), 0);
    expect(f.multipassCalls).toBe(0);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(sourceTokens).toBeLessThanOrEqual(2048 - 1024 - 512);
  });
});

describe("answer(): unexpected failures", () => {
  it("still ends with a done event when something throws before generation", async () => {
    f.deps.getSettings = async () => {
      throw new Error("settings file corrupted");
    };
    const { events, result } = await collect("Tell me about Canberra");
    expect(result.outcome).toBe("error");
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "error", error: { code: "unknown", message: "settings file corrupted" } });
  });
});

describe("answer(): rule D6", () => {
  it("does not auto-pick a deep model measured below 5 tok/s; goes multi-pass on the picked model instead", async () => {
    f.installed = [qwen15, qwen7];
    f.settings.alwaysComplete = true;
    f.deps.getModelSpeeds = async () => new Map([["qwen7", 2.7]]);
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(f.loads).not.toContain(qwen7.filename);
    expect(f.multipassCalls).toBe(1);
    expect(result.receipt.reasonCodes).toContain("deep-auto:skip-qwen7-too-slow-2.7tps");
  });

  it("uses a slow deep model when the user picked it explicitly", async () => {
    f.installed = [qwen15, qwen7];
    f.settings.alwaysComplete = true;
    f.settings.deepModelId = "qwen7";
    f.deps.getModelSpeeds = async () => new Map([["qwen7", 2.7]]);
    const { result } = await collect("Why was Canberra chosen as the capital of Australia?");
    expect(result.receipt.modelId).toBe("qwen7");
  });
});

describe("answer(): device-dependent default model", () => {
  const q4b: InstalledLlm = { id: "qwen3-4b", label: "Qwen3 4B", filename: "models/q4b.gguf", sizeBytes: 2.5 * GB, roles: ["fast"], answerTier: "default" };
  const q15c: InstalledLlm = { ...qwen15, isDefault: false, answerTier: "compact" };

  it("uses the 4B when the user has not picked a model and it fits", async () => {
    f.installed = [q15c, q4b];
    f.activeId = null;
    f.settings.quickFirst = false;
    f.deps.deviceRamBytes = () => 7.5 * GB;
    const { result } = await collect("Tell me about Canberra");
    expect(result.receipt.modelId).toBe("qwen3-4b");
  });

  it("uses the compact model on a 4 GB phone", async () => {
    f.installed = [q15c, q4b];
    f.activeId = null;
    f.settings.quickFirst = false;
    f.deps.deviceRamBytes = () => 3.7 * GB;
    const { result } = await collect("Tell me about Canberra");
    expect(result.receipt.modelId).toBe("qwen1.5");
  });

  it("still respects the model the user picked", async () => {
    f.installed = [q15c, q4b];
    f.activeId = "qwen1.5";
    f.settings.quickFirst = false;
    f.deps.deviceRamBytes = () => 12 * GB;
    const { result } = await collect("Tell me about Canberra");
    expect(result.receipt.modelId).toBe("qwen1.5");
  });
});

describe("answer(): execution telemetry (regression since 4e4f49d: nothing recorded)", () => {
  it("records one execution at the end of a model's answer", async () => {
    const { result } = await collect("What is the capital of Australia and where is it?");
    expect(result.tier).toBe("fast");
    expect(f.records).toHaveLength(1);
    const r = f.records[0];
    expect(r).toMatchObject({
      modelId: "qwen1.5",
      taskType: expect.any(String),
      adaptiveRoutingUsed: true,
      modelResidency: "cold",
      tokensGenerated: 5,
      generationLatencyMs: 50,
      outcome: "success",
    });
    expect(r.tokPerSec).toBeCloseTo(100);
    expect(r.ttftMs).toBeGreaterThan(0);
    expect(r.totalLatencyMs).toBeGreaterThanOrEqual(r.ttftMs!);
    expect(r.reasonCodes).toEqual(result.receipt.reasonCodes);
  });

  it("records the model as resident on the next answer, and one record per answer", async () => {
    await collect("What is the capital of Australia and where is it?");
    await collect("What is the capital of Australia and where is it?");
    expect(f.records.map((r) => r.modelResidency)).toEqual(["cold", "resident"]);
  });

  it("records nothing when the model never generated (load failed)", async () => {
    f.loadError = "boom";
    const { result } = await collect("What is the capital of Australia and where is it?");
    expect(result.outcome).toBe("error");
    expect(f.records).toHaveLength(0);
  });

  it("records a failed generation as a failure with its message", async () => {
    f.deps.engine.generate = async () => {
      throw new Error("decode crashed");
    };
    const { result } = await collect("What is the capital of Australia and where is it?");
    expect(result.outcome).toBe("error");
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ modelId: "qwen1.5", outcome: "failure", errorMessage: "decode crashed" });
  });

  it("keeps the chat's tone prefix prefilled for the next question (engine.setAnswerPrefix)", async () => {
    const prefixes: unknown[] = [];
    f.deps.engine.setAnswerPrefix = (p) => prefixes.push(p);
    f.deps.answerPrefix = answerPromptPrefix;
    const { answer } = createAnswerer(f.deps);
    await answer({ query: "What is the capital of Australia and where is it?" }, () => {}, { maxTokens: 256, systemPrompt: "Be brief." }).done;
    expect(prefixes).toEqual([answerPromptPrefix("Be brief.")]);
    // What the model got starts with it, so the prefilled part is reused.
    expect(f.generations[0].messages![0].content.startsWith(answerPromptPrefix("Be brief.").system)).toBe(true);
  });

  it("records the peak of the app's memory from the load to the end (iOS showed an empty peak)", async () => {
    // The footprint grows at load (KV cache, buffers) and during the answer, then falls back.
    const readings = [900e6, 1400e6, 1650e6, 1500e6, 1450e6];
    let i = 0;
    f.deps.memoryBytes = () => readings[Math.min(i++, readings.length - 1)];
    await collect("What is the capital of Australia and where is it?");
    expect(f.records).toHaveLength(1);
    expect(f.records[0].peakRssBytes).toBe(1650e6);
  });

  it("leaves the peak empty when the build has no memory readout", async () => {
    f.deps.memoryBytes = () => {
      throw new Error("RamMonitor not linked");
    };
    const { result } = await collect("What is the capital of Australia and where is it?");
    expect(result.outcome).toBe("success");
    expect(f.records[0].peakRssBytes).toBeUndefined();
  });

  it("a telemetry write failure never breaks the answer", async () => {
    f.deps.recordExecution = async () => {
      throw new Error("sqlite locked");
    };
    const { result } = await collect("What is the capital of Australia and where is it?");
    expect(result.outcome).toBe("success");
  });
});

describe("answer(): the model's own reference list (CT-A)", () => {
  it("removes '[1] Monsoon, Wikipedia, acessado em 1 de fevereiro de 2023' from the final text", async () => {
    const line = "[1] Monsoon, Wikipedia, acessado em 1 de fevereiro de 2023";
    f.deps.engine.generate = async (opts) => {
      const pieces = ["Canberra is the capital of Australia [1].", "\n\n", line];
      for (const p of pieces) opts.onToken?.(p);
      opts.onTimings?.({ promptTokens: 100, promptMs: 10, predictedTokens: 3, predictedMs: 30 });
      return pieces.join("");
    };
    const { events, result } = await collect("What is the capital of Australia and where is it?");
    expect(result.tier).toBe("fast");
    expect(result.text).not.toContain("Monsoon");
    expect(result.text).not.toContain("acessado");
    expect(result.text).toMatch(/^Canberra is the capital of Australia \[1\]\.$/);
    const done = events.find((e) => e.type === "done") as any;
    expect(done.finalText).toBe(result.text);
    expect(done.cited).toEqual([1]);
    expect(result.receipt.reasonCodes).toContain("grounding:model-references-stripped");
  });
});

describe("answer(): multi-pass retrieval progress", () => {
  const SYDNEY = chunk("c4", "Sydney", "Sydney is the capital city of New South Wales and the most populous city in Australia.");
  const withRelevance = (c: RetrievedChunk, relevance: number) => ({ ...c, relevance });

  it("sends each sub-question's sources as found, with the sub-question in the stage; the final list and numbers are unchanged", async () => {
    f.deps.runMultipass = async (_q, _s, _h, _m, onProgress, onToken, _stop, options) => {
      onProgress({ stage: "decomposing" });
      onProgress({ stage: "researching", subQuestionIndex: 0, subQuestionCount: 2, subQuestion: "Why was Canberra chosen?" });
      options.onPartialSources?.([withRelevance(CANBERRA, 0.9)], { subQuestionIndex: 0, subQuestionCount: 2 });
      onProgress({ stage: "researching", subQuestionIndex: 1, subQuestionCount: 2, subQuestion: "What is Sydney?" });
      options.onPartialSources?.([withRelevance(CANBERRA, 0.9), withRelevance(SYDNEY, 0.4)], { subQuestionIndex: 1, subQuestionCount: 2 });
      options.onSources?.([CANBERRA, SYDNEY]);
      onProgress({ stage: "synthesizing" });
      onToken("Canberra [1], Sydney [2].");
      return { answer: "Canberra [1], Sydney [2].", subQuestions: ["a", "b"], citations: [CANBERRA, SYDNEY] };
    };
    const events: AnswerEvent[] = [];
    const { deepen } = createAnswerer(f.deps);
    const result = await deepen("Compare Canberra and Sydney", [CANBERRA], (e) => events.push(e), ctx).done;

    const seq = events
      .filter((e) => e.type !== "stage" || e.stage === "retrieving" || e.stage === "synthesizing")
      .map((e) =>
        e.type === "stage"
          ? `stage:${e.stage}${e.detail?.subQuestion ? `:${e.detail.index}:${e.detail.subQuestion}` : ""}`
          : e.type === "sources"
            ? `sources:${e.sources.map((c) => c.chunkId).join(",")}`
            : e.type
      );
    expect(seq).toEqual([
      "stage:retrieving",
      "stage:retrieving:0:Why was Canberra chosen?",
      "sources:c1",
      "stage:retrieving:1:What is Sydney?",
      "sources:c1,c4",
      "sources:c1,c4",
      "stage:synthesizing",
      "token",
      "done",
    ]);
    // No comparable relevance across sub-questions, in partial lists too.
    for (const e of events) if (e.type === "sources") expect(e.sources.every((c) => c.relevance === undefined)).toBe(true);
    expect(result.sources.map((c) => c.chunkId)).toEqual(["c1", "c4"]);
    expect(result.cited).toEqual([1, 2]);

    // The chat's reducer (it merges sources events) ends with the same list, in the same order: [n] = sources[n-1].
    let state = initialAnswer(result.answerId);
    for (const e of events) state = answerReducer(state, e);
    expect(state.sources.map((c) => c.chunkId)).toEqual(result.sources.map((c) => c.chunkId));
  });

  it("a single-pass answer still sends one sources event, after grounding", async () => {
    const { events } = await collect("Why was Canberra chosen as the capital?");
    expect(events.filter((e) => e.type === "sources")).toHaveLength(1);
    const kinds = types(events);
    expect(kinds.indexOf("stage:retrieving")).toBeLessThan(kinds.indexOf("sources"));
  });
});

describe("answer(): multi-pass citations (P1 full cited chunks, P2 attribution)", () => {
  // What the orchestrator shows for Canberra after compressing it to a sub-question's budget: the 1908 sentence is gone.
  const CANBERRA_COMPRESSED = { ...CANBERRA, body: "Canberra is the capital city of Australia." };
  const SELECTED = "The site of Canberra was selected for the location of the nation's capital in 1908 as a compromise between Sydney and Melbourne";
  const multipass = (answer: string, full?: RetrievedChunk[]) => {
    f.deps.runMultipass = async (_q, _s, _h, _m, onProgress, onToken, _stop, options) => {
      options.onSources?.([CANBERRA_COMPRESSED, HALL]);
      onProgress({ stage: "synthesizing" });
      onToken(answer);
      return { answer, subQuestions: ["a", "b"], citations: [CANBERRA_COMPRESSED, HALL], ...(full ? { fullCitations: full } : {}) };
    };
  };
  const run = async (reused: RetrievedChunk[] = [HALL]) => {
    const { deepen } = createAnswerer(f.deps);
    // By default the reused sources leave Canberra out: its full text can only come from fullCitations.
    return deepen("Why was Canberra chosen as the capital of Australia?", reused, () => {}, ctx).done;
  };

  it("P1: CT-1 checks a synthesis [n] against the full retrieved chunk, not the compressed body", async () => {
    multipass(`${SELECTED} [1].`, [CANBERRA, HALL]);
    const r = await run();
    expect(r.text).toContain(`${SELECTED} [1]`);
    expect(r.receipt.reasonCodes.some((c) => c.startsWith("citations:removed"))).toBe(false);
    expect(r.cited).toEqual([1]);
  });

  it("P1 and P2 hold when the earlier answer's compressed sources are reused (the usual deeper answer)", async () => {
    multipass(`${SELECTED} [1].`, [CANBERRA, HALL]);
    const checked = await run([CANBERRA_COMPRESSED, HALL]);
    expect(checked.receipt.reasonCodes.some((c) => c.startsWith("citations:removed"))).toBe(false);
    expect(checked.cited).toEqual([1]);
    multipass(`${SELECTED}. Canberra has the best coffee in the southern hemisphere.`, [CANBERRA, HALL]);
    const restored = await run([CANBERRA_COMPRESSED, HALL]);
    expect(restored.receipt.reasonCodes).toContain("citations:added-1");
    expect(restored.text).toContain(`${SELECTED} [1].`);
  });

  it("P1 control: without the full chunks the same [n] is judged against the compressed body and removed", async () => {
    multipass(`${SELECTED} [1].`);
    const r = await run();
    expect(r.receipt.reasonCodes).toContain("citations:removed-1");
    expect(r.text).not.toMatch(/\[1\]/);
  });

  it("P2: attribution restores the [n] a full source supports, and never adds one without support", async () => {
    multipass(`${SELECTED}. Canberra has the best coffee in the southern hemisphere.`, [CANBERRA, HALL]);
    const r = await run();
    expect(r.receipt.reasonCodes).toContain("citations:added-1");
    expect(r.text).toContain(`${SELECTED} [1].`);
    expect(r.text).toMatch(/southern hemisphere\.$/);
    expect(r.cited).toEqual([1]);
  });
});

describe("answer(): multi-pass answer language", () => {
  it("a Portuguese question asks the synthesis for Portuguese; an English one doesn't", async () => {
    const seen: (string | undefined)[] = [];
    const base = f.deps.runMultipass;
    f.deps.runMultipass = (q, s, h, m, p, t, st, options) => {
      seen.push(options.answerLanguage);
      return base(q, s, h, m, p, t, st, options);
    };
    const { deepen } = createAnswerer(f.deps);
    await deepen("Compare Canberra e Sydney: qual é a capital da Austrália?", [CANBERRA], () => {}, ctx).done;
    await deepen("Compare Canberra and Sydney", [CANBERRA], () => {}, ctx).done;
    expect(seen).toEqual([PT_ANSWER_LANGUAGE, undefined]);
  });
});

describe("answer(): a conversation limited to some documents", () => {
  it("searches only those collections, never places nor multi-pass", async () => {
    const asked: Array<string[] | undefined> = [];
    const lease = { ...chunk("l1", "contrato.txt", "O IPTU é pago pelo LOCATÁRIO junto com o aluguel."), collectionId: "custom-1" };
    f.deps.retrieve = async (_q, _k, collections) => (asked.push(collections), [lease]);
    const events: AnswerEvent[] = [];
    const h = createAnswerer(f.deps).answer({ query: "Restaurants near me?", collections: ["custom-1"] }, (e) => events.push(e), ctx);
    const result = await h.done;
    expect(asked).toEqual([["custom-1"]]);
    expect(events.some((e) => e.type === "places")).toBe(false);
    expect(result.receipt.reasonCodes).toContain("retrieve:scoped-1");
    expect(f.multipassCalls).toBe(0);
  });
});
