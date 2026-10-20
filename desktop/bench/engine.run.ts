/// <reference types="node" />
/**
 * The benchmark: the app's own engine (src/inference/LlamaEngine.ts, src/rag/embed.ts, seedCorpus, retrieve, and the
 * live answer pipeline through src/eval/answerEval.ts), unmodified, on the desktop shims in one Node process, no window.
 * Run it with `npm run bench` (bench/run.mjs sets the BOAR_BENCH_* variables read below and prints the table).
 *
 * Phases: embedding model load + indexing the bundled corpus -> retrieval set -> LLM cold load -> engine microbench
 * (fixed prompts, temperature 0) -> the eval set through answer() -> score v1 (src/eval/score.pure.ts) + fact checks.
 */
import { it, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loopback } from "../src/testing/loopback";
import { getLlamaInstance } from "../src/main/llama/engine";
import { register as llamaHandlers } from "../src/main/handlers/llama.rn";
import { register as sqlite } from "../src/main/handlers/expo-sqlite";
import { register as fsLegacy } from "../src/main/handlers/expo-file-system-legacy";
import { register as fsNew } from "../src/main/handlers/expo-file-system";
import { register as ramMonitor } from "../src/main/handlers/ram-monitor";
import { register as fileHash } from "../src/main/handlers/file-hash";

const env = process.env;
const MODE = env.BOAR_BENCH_MODE === "full" ? "full" : "quick";
const MODELS_DIR = env.BOAR_TEST_MODELS_DIR ?? "";
const OUT = env.BOAR_BENCH_OUT ?? "";
const num = (v: string | undefined) => (v && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Every completion the engine runs (what the native side reports), tagged with the phase/question running. */
const state = vi.hoisted(() => ({
  tag: "setup",
  completions: [] as Array<{ tag: string; warm: boolean; prompt_n: number; prompt_ms: number; predicted_n: number; predicted_ms: number; cached: number; text: string }>,
  backend: {} as { gpu?: boolean; devices?: string[]; reasonNoGPU?: string },
}));

// Native packages -> desktop shims, as Metro does with BOAR_TARGET=desktop (desktop/src/shared/packages.json).
vi.mock("expo-sqlite", () => import("../src/shims/expo-sqlite"));
vi.mock("expo-file-system", () => import("../src/shims/expo-file-system"));
vi.mock("expo-file-system/legacy", () => import("../src/shims/expo-file-system-legacy"));
vi.mock("file-hash", () => import("../src/shims/file-hash"));
vi.mock("ram-monitor", () => import("../src/shims/ram-monitor"));
vi.mock("offline-location", () => import("../src/shims/offline-location"));
vi.mock("download-wake-lock", () => import("../src/shims/download-wake-lock"));
vi.mock("device-key", () => import("../src/shims/device-key"));
vi.mock("voice-input", () => import("../src/shims/voice-input"));
vi.mock("expo-sharing", () => import("../src/shims/expo-sharing"));
vi.mock("expo-document-picker", () => import("../src/shims/expo-document-picker"));
vi.mock("expo-pdf-text-extract", () => import("../src/shims/expo-pdf-text-extract"));
vi.mock("bundled-assets", () => ({ excludeFromBackup: async () => {} }));
vi.mock("react-native", () => ({ Platform: { OS: "web", select: (o: any) => o.web ?? o.default } }));
// --k / --context-tokens: the normal (fast) answer's sources and their token budget, instead of the phone-tuned
// quickBudget (src/routing/depth.ts: 3-4 sources, 450-700 tokens). Applied to the plan answer() runs.
vi.mock("../../src/routing/depth", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/routing/depth")>();
  const n = (v: string | undefined) => (v && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const k = n(process.env.BOAR_BENCH_K);
  const tokens = n(process.env.BOAR_BENCH_CONTEXT_TOKENS);
  return {
    ...m,
    planAnswer: (i: Parameters<typeof m.planAnswer>[0]) => {
      const p = m.planAnswer(i);
      if (p.generation?.tier !== "fast") return p;
      return { ...p, generation: { ...p.generation, ...(k ? { retrieveK: k } : {}), ...(tokens ? { contextTokens: tokens } : {}) } };
    },
  };
});
// llama.rn = the shim, with the bench's knobs applied to every LLM context and each completion's timings recorded.
// The seed makes sampling repeatable (the app sends none); temperature stays the app's.
vi.mock("llama.rn", async () => {
  const shim = await import("../src/shims/llama.rn");
  const e = process.env;
  const n = (v: string | undefined) => (v && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    ...shim,
    initLlama: async (params: any, onProgress?: (p: number) => void) => {
      const p = { ...params };
      if (!p.embedding) {
        p.n_ctx = n(e.BOAR_BENCH_CTX) ?? p.n_ctx;
        p.n_threads = n(e.BOAR_BENCH_THREADS) ?? p.n_threads;
        if (e.BOAR_BENCH_KV) p.cache_type_k = p.cache_type_v = e.BOAR_BENCH_KV;
        if (n(e.BOAR_GPU_LAYERS) === 0) p.devices = ["CPU"]; // the engine's CPU-only path
      }
      const ctx = await shim.initLlama(p, onProgress);
      if (!p.embedding) Object.assign(state.backend, { gpu: ctx.gpu, devices: ctx.devices, reasonNoGPU: ctx.reasonNoGPU });
      const completion = ctx.completion.bind(ctx);
      ctx.completion = async (cp: any, cb?: any) => {
        const r = await completion({ seed: n(e.BOAR_BENCH_SEED) ?? 42, ...cp }, cb);
        const t = r.timings ?? ({} as any);
        state.completions.push({
          tag: state.tag,
          warm: cp.n_predict === 0,
          prompt_n: t.prompt_n ?? 0,
          prompt_ms: t.prompt_ms ?? 0,
          predicted_n: t.predicted_n ?? 0,
          predicted_ms: t.predicted_ms ?? 0,
          cached: r.tokens_cached ?? 0,
          text: r.text ?? "", // what the model wrote, before answer()'s checks can replace it (the diagnosis needs it)
        });
        return r;
      };
      return ctx;
    },
  };
});

/**
 * Bench-only questions (full mode), next to EVAL_SET: what the app must decline, and Portuguese questions on articles
 * the bundled corpus has. Kept here, not in src/eval/evalSet.ts, so EVAL_SET_VERSION and the phone's results don't move.
 */
const EXTRA_SET: Array<{ id: string; category: string; query: string; expectedKbTitles: string[] }> = [
  // Made-up or unknowable: nothing true to say. Answering = a false answer, unless the text says it doesn't know.
  { id: "decline-1", category: "no-kb-content", query: "What did the Treaty of Velmora of 1823 establish?", expectedKbTitles: [] },
  { id: "decline-2", category: "no-kb-content", query: "What is the melting point of the element zorbium?", expectedKbTitles: [] },
  { id: "decline-3", category: "no-kb-content", query: "Who won the 2042 FIFA World Cup?", expectedKbTitles: [] },
  { id: "decline-pt-1", category: "no-kb-content", query: "Quem fundou a cidade de Vrelândia do Sul?", expectedKbTitles: [] },
  // Portuguese, on corpus articles (English text): the answer must come, in substance.
  { id: "pt-1", category: "explanation", query: "Como funcionam as vacinas?", expectedKbTitles: ["Vaccine"] },
  { id: "pt-2", category: "explanation", query: "O que é a fotossíntese?", expectedKbTitles: ["Photosynthesis"] },
  { id: "pt-3", category: "retrieval-grounded", query: "O que é um buraco negro?", expectedKbTitles: ["Black hole"] },
  { id: "pt-4", category: "factual", query: "Quem propôs a teoria da evolução por seleção natural?", expectedKbTitles: ["Evolution"] },
  { id: "pt-5", category: "retrieval-grounded", query: "Por que o Império Romano do Ocidente caiu?", expectedKbTitles: ["Fall of the Western Roman Empire"] },
];

/**
 * What a right response is, per question: "answer" (the corpus has the article, or no source is needed: greeting,
 * arithmetic), "decline" (nothing true to say), "either" (real, but not in the corpus: the compact model declines by
 * product decision, the 4B answers from memory with a notice). A false decline is "answer" declined; a false answer is
 * "decline" answered without saying it doesn't know.
 */
const EXPECT: Record<string, "answer" | "decline" | "either"> = {
  // Real questions whose answer the bundled corpus doesn't hold (its articles are the Wikipedia intro only):
  "factual-1": "either", // Canberra: no Australia article
  "factual-2": "either", // the Evolution intro never names Darwin
  "pt-4": "either", // same, in Portuguese
  "synthesis-1": "either", // "Agricultural revolution" is a disambiguation page
  "synthesis-3": "either", // the Amazon intro is geography only: nothing on climate or biodiversity
  "no-kb-1": "either", // Napoleon: not in the corpus (only "Randy Napoleon", which must not be cited)
  "decline-1": "decline",
  "decline-2": "decline",
  "decline-3": "decline",
  "decline-pt-1": "decline",
};
const SAYS_UNKNOWN =
  /(don'?t|do not|didn'?t|did not|couldn'?t|could not|cannot|can'?t) (know|find|have|confirm|provide)|no (information|record|reliable|such)|not (aware|sure|found|available|a real)|(fictional|fictitious|hypothetical|doesn'?t exist|does not exist|hasn'?t (happened|taken place)|has not (happened|taken place)|future)|there is no (known |such )?(\w+ ){1,3}(called|named|referred to as|known as)|no verifiable (record|evidence|source)|cannot be confirmed|não (sei|encontrei|há|existe|tenho|consegui)|(fict[íi]ci|inexistente|ainda não)/i;

const QUICK_QUERIES = ["greeting-1", "factual-1", "explanation-1", "explanation-2", "comparison-1", "reasoning-1", "grounded-2", "no-kb-1"];

/**
 * Bench-only fact checks ("facts v1"): a regex for what a correct answer must say, from the eval set's gradingNotes.
 * Score v1 (docs/RESULTS_SCORE.md) doesn't grade answers; this is the cheapest signal that it isn't wrong.
 * ponytail: keyword match, not a judge; an LLM judge (eval/scripts upstream) is the upgrade when one runs here.
 */
const FACTS: Record<string, (a: string) => boolean> = {
  "factual-1": (a) => /canberra/i.test(a),
  "factual-2": (a) => /darwin/i.test(a),
  "explanation-1": (a) => /immun/i.test(a) && /(memory|antibod)/i.test(a),
  "explanation-2": (a) => /(carbon dioxide|co2|co₂)/i.test(a) && /oxygen/i.test(a),
  "comparison-1": (a) => /(1789|1799|monarch|political)/i.test(a) && /(1760|1840|econom|machine|steam|factor(y|ies))/i.test(a),
  "synthesis-2": (a) => /(antibod|memory|b cell|t cell|adaptive)/i.test(a),
  "reasoning-1": (a) => /6[:.]15/.test(a),
  "reasoning-2": (a) => /8[.,]3/.test(a),
  "reasoning-3": (a) => /100\s*GB/i.test(a),
  "grounded-1": (a) => /(476|invasion|invad|barbarian|goth|vandal)/i.test(a),
  "grounded-2": (a) => /(event horizon|escap)/i.test(a), // "escaping" counts (it didn't, 4B run)
  "no-kb-1": (a) => /emperor/i.test(a) && !/randy/i.test(a),
  "no-kb-2": (a) => /bacteri/i.test(a) && /resist/i.test(a),
  "pt-1": (a) => /imun/i.test(a) && /(mem[óo]ria|anticorpo)/i.test(a),
  "pt-2": (a) => /(di[óo]xido de carbono|g[áa]s carb[ôo]nico|co2|co₂)/i.test(a) && /oxig[êe]nio/i.test(a),
  "pt-3": (a) => /(horizonte de eventos|luz|escap)/i.test(a),
  "pt-4": (a) => /darwin/i.test(a),
  "pt-5": (a) => /(476|invas|b[áa]rbar|godos|v[âa]ndalos)/i.test(a),
};

/** Retrieval negatives: nothing should come back. greeting-1 and no-kb-1 from EVAL_SET, the rest from scripts/rag-calibrate.mjs. */
const NEGATIVES = ["hey, what's up?", "Who was Napoleon Bonaparte?", "whats your name?", "who are you?", "what can you do?", "tell me a joke", "what time is it?", "can you help me?"];
const RETRIEVE_K = 6; // what answer() asks for (src/routing/answer.ts, retrieveK ?? 6)

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2 : undefined;
};
const round = (x: number | undefined, d = 1) => (x === undefined ? undefined : Math.round(x * 10 ** d) / 10 ** d);
const MB = 1024 * 1024;

it("benchmark", async () => {
  if (!MODELS_DIR) throw new Error("BOAR_TEST_MODELS_DIR is not set (folder with the app's .gguf files)");
  const { MODEL_CATALOG } = await import("../../src/models/manifest");
  const modelArg = env.BOAR_BENCH_MODEL || "qwen2.5-1.5b-instruct-q4km";
  const llm = MODEL_CATALOG.find((m) => m.kind === "llm" && (m.id === modelArg || path.basename(m.filename) === modelArg));
  if (!llm) throw new Error(`--model ${modelArg}: not an LLM in src/models/manifest.ts (use its id or file name)`);
  const emb = MODEL_CATALOG.find((m) => m.id === "bge-small-en-v1.5-q8")!;

  // A fresh data folder each run (no telemetry or settings from an earlier run); models hard-linked in, never copied.
  // Leftovers of earlier runs (Windows can keep a file locked past the end of a run): small, but don't pile up.
  // Only those over 3 hours old: another run may be going in parallel (another worktree).
  const stale = (d: string) => Date.now() - fs.statSync(path.join(os.tmpdir(), d)).mtimeMs > 3 * 3600_000;
  for (const d of fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("boar-bench-"))) {
    try {
      if (stale(d)) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    } catch {}
  }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "boar-bench-")));
  const dataDir = path.join(root, "data");
  const { native, ctx } = loopback(dataDir);
  for (const register of [sqlite, fsLegacy, fsNew, ramMonitor, fileHash, llamaHandlers]) register(ctx);
  (globalThis as any).window = { boarNative: native };
  fs.mkdirSync(path.join(dataDir, "documents", "models"), { recursive: true });
  for (const m of [llm, emb]) {
    const src = path.join(MODELS_DIR, path.basename(m.filename));
    if (!fs.existsSync(src)) throw new Error(`missing ${src}`);
    fs.linkSync(src, path.join(dataDir, "documents", m.filename));
  }
  // --wiki: one English Wikipedia shard installed next to the bundled corpus (as bench/docs.run.ts does), so retrieval
  // finds what a user with a pack gets: more sources, and longer ones, for the context budget to cut.
  const wikiShard = path.join(MODELS_DIR, "corpus", "boar-wiki-en-00.sqlite");
  if (env.BOAR_BENCH_WIKI === "1") {
    if (!fs.existsSync(wikiShard)) throw new Error(`--wiki: missing ${wikiShard}`);
    fs.mkdirSync(path.join(dataDir, "documents", "corpus"), { recursive: true });
    fs.linkSync(wikiShard, path.join(dataDir, "documents", "corpus", path.basename(wikiShard)));
  }

  // Peak RAM (this process holds the models: RSS includes mmap'd weights) and VRAM (node-llama-cpp's reading).
  const llama = await getLlamaInstance();
  const vramUsed = async () => (llama.gpu ? (await llama.getVramState()).used : 0);
  const vramBase = await vramUsed();
  let peakRss = 0;
  let peakVram = vramBase;
  let sampling = false;
  const sampler = setInterval(async () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (sampling) return;
    sampling = true;
    peakVram = Math.max(peakVram, await vramUsed().catch(() => 0));
    sampling = false;
  }, 250);

  try {
    const settings = await import("../../src/models/settings");
    await settings.setActiveModelId("llm", llm.id);
    const { embeddingEngine } = await import("../../src/rag/embed");
    const { seedKnowledgeBaseIfEmpty } = await import("../../src/rag/seedCorpus");
    const { retrieve } = await import("../../src/rag/retrieve");
    const { EVAL_SET, EVAL_SET_VERSION } = await import("../../src/eval/evalSet");

    // 1. Embedding model + indexing the bundled corpus (what the chat does on first start).
    let t = performance.now();
    await embeddingEngine.load(emb.filename);
    const embedLoadMs = performance.now() - t;
    t = performance.now();
    await seedKnowledgeBaseIfEmpty();
    const indexMs = performance.now() - t;
    const db = await import("../../src/rag/db");
    const indexDocs = (await (await db.getDb()).getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM chunks"))!.n;

    // 2. Retrieval: EVAL_SET questions that expect corpus articles, and negatives.
    state.tag = "retrieval";
    const positives = EVAL_SET.filter((q) => q.expectedKbTitles.length > 0);
    const perQuery: any[] = [];
    for (const q of positives) {
      const t0 = performance.now();
      const hits = await retrieve(q.query, RETRIEVE_K);
      const ms = performance.now() - t0;
      const titles = [...new Set(hits.map((h) => h.title))];
      const ranks = q.expectedKbTitles.map((x) => titles.indexOf(x) + 1).filter((r) => r > 0);
      perQuery.push({
        id: q.id,
        expected: q.expectedKbTitles,
        got: titles,
        hit: ranks.length === q.expectedKbTitles.length,
        recall: ranks.length / q.expectedKbTitles.length,
        rr: ranks.length ? 1 / Math.min(...ranks) : 0,
        top1: q.expectedKbTitles.includes(titles[0]),
        ms: Math.round(ms),
      });
    }
    const negatives: any[] = [];
    for (const query of NEGATIVES) {
      const t0 = performance.now();
      const hits = await retrieve(query, RETRIEVE_K);
      negatives.push({ query, got: [...new Set(hits.map((h) => h.title))], ms: Math.round(performance.now() - t0) });
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const retrieval = {
      k: RETRIEVE_K,
      questions: perQuery.length,
      hitAtK: round(avg(perQuery.map((p) => (p.hit ? 1 : 0))), 3),
      recallAtK: round(avg(perQuery.map((p) => p.recall)), 3),
      mrr: round(avg(perQuery.map((p) => p.rr)), 3),
      hitAt1: round(avg(perQuery.map((p) => (p.top1 ? 1 : 0))), 3),
      negatives: negatives.length,
      negativesEmpty: round(avg(negatives.map((n) => (n.got.length === 0 ? 1 : 0))), 3),
      medianMs: round(median([...perQuery, ...negatives].map((p) => p.ms)), 0),
      perQuery,
      negativeDetails: negatives,
    };

    // 3. LLM cold load, as answer() would do it.
    state.tag = "load";
    const { llamaEngine } = await import("../../src/inference/LlamaEngine");
    t = performance.now();
    await llamaEngine.load(llm.filename, { meta: { modelId: llm.id, label: llm.label } });
    const llmLoadMs = performance.now() - t;
    const vramAfterLoad = await vramUsed();
    const nCtx = llamaEngine.getModelInfo()?.nCtx;

    // 4. Microbench: fixed prompts at temperature 0. Each rep's prompt differs at the start, so nothing is reused
    // from the KV cache: decode = a 128-token answer; prefill = ~1.5k tokens of corpus text, 1 token out.
    const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "../../assets/corpus/corpus.json"), "utf8")) as Array<{ title: string; body: string }>;
    const longText = corpus.slice(0, 40).map((d) => d.body).join("\n").slice(0, 6000);
    const reps = MODE === "full" ? 8 : 5; // rep 0 is warm-up (shader compile, first touch of the weights): left out of the medians
    const micro = { decode: [] as any[], prefill: [] as any[] };
    for (let i = 0; i < reps; i++) {
      state.tag = "micro-decode";
      let first = 0;
      let timings: any;
      const t0 = performance.now();
      await llamaEngine.generate({
        messages: [
          { role: "system", content: `Run ${i}. You are a concise assistant.` },
          { role: "user", content: "Explain how a bicycle works, step by step, in about 120 words." },
        ],
        nPredict: 128,
        temperature: 0,
        onToken: () => (first ||= performance.now()),
        onTimings: (x) => (timings = x),
      });
      micro.decode.push({
        ttftMs: first - t0,
        tokens: timings.predictedTokens,
        tokPerSec: (timings.predictedTokens * 1000) / timings.predictedMs,
        promptTokens: timings.promptTokens,
      });
      state.tag = "micro-prefill";
      await llamaEngine.generate({
        messages: [
          { role: "system", content: `Run ${i}. Answer in one word.` },
          { role: "user", content: `${longText}\n\nWhich article above is the first one?` },
        ],
        nPredict: 1,
        temperature: 0,
        onTimings: (x) => (timings = x),
      });
      micro.prefill.push({ tokens: timings.promptTokens, ms: timings.promptMs, tokPerSec: (timings.promptTokens * 1000) / timings.promptMs });
    }

    // 5. The eval set through the live answer pipeline (the chat's answer()), like a device request with pipeline "answer".
    const { runAnswerEvaluation } = await import("../../src/eval/answerEval");
    const { expectedKbHit } = await import("../../src/eval/evalHarness.pure");
    const { scoreRun, SCORE_VERSION } = await import("../../src/eval/score.pure");
    const set = MODE === "full" ? [...EVAL_SET, ...EXTRA_SET] : EVAL_SET.filter((q) => QUICK_QUERIES.includes(q.id));
    const run = await runAnswerEvaluation({
      questions: set.map((q) => ({ id: q.id, query: q.query, category: q.category })),
      evalSetVersion: EVAL_SET_VERSION,
      onProgress: (p) => (state.tag = `q:${p.query.id}`),
    });
    state.tag = "done";
    // The answer rows leave expected titles empty (any dataset); EVAL_SET has them, so fill them in as evalHarness does.
    const rows = run.rows.map((r) => {
      const q = [...EVAL_SET, ...EXTRA_SET].find((x) => x.id === r.queryId)!;
      return { ...r, expectedKbTitles: q.expectedKbTitles, expectedKbHit: expectedKbHit(q.expectedKbTitles, r.retrievedTitles) };
    });
    const [score] = scoreRun(rows);
    const answers = rows.map((r) => {
      const own = state.completions.filter((c) => c.tag === `q:${r.queryId}` && !c.warm);
      const fact = FACTS[r.queryId];
      const expect = EXPECT[r.queryId] ?? "answer";
      return {
        id: r.queryId,
        outcome: r.outcome,
        error: r.errorMessage || undefined,
        tier: r.tier,
        declined: r.declined,
        modelLoadMs: round(r.modelLoadMs, 0),
        firstSourcesMs: round(r.firstSourcesMs, 0),
        ttftMs: round(r.ttftMs, 0),
        totalMs: round(r.totalLatencyMs, 0),
        tokens: r.tokensGenerated,
        tokPerSec: round(r.tokPerSec),
        prefillTokens: own.reduce((a, c) => a + c.prompt_n, 0), // prompt_n = tokens evaluated now (cached ones excluded)
        prefillMs: round(own.reduce((a, c) => a + c.prompt_ms, 0), 0),
        cachedTokens: own.reduce((a, c) => a + c.cached, 0),
        completions: own.length,
        retrieved: r.retrievedTitles,
        expected: r.expectedKbTitles,
        expectedHit: r.expectedKbHit,
        fact: fact ? fact(r.answer) : null,
        expect,
        falseDecline: expect === "answer" && r.declined,
        falseAnswer: expect === "decline" && !r.declined && !SAYS_UNKNOWN.test(r.answer),
        // Answered (not declined) and the fact check fails: a confident error.
        wrongAnswer: !!fact && !r.declined && !fact(r.answer),
        reasonCodes: r.reasonCodes,
        modelText: own.map((c) => c.text),
        answer: r.answer,
      };
    });
    const graded = answers.filter((a) => a.fact !== null);
    const dec = micro.decode.slice(1); // the first rep carries warm-up; medians below skip it
    const pre = micro.prefill.slice(1);

    let commit = "";
    try {
      commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain", { encoding: "utf8" }).trim() ? "+dirty" : "");
    } catch {}
    const result = {
      meta: {
        label: env.BOAR_BENCH_LABEL || "run",
        mode: MODE,
        date: new Date().toISOString(),
        commit,
        model: llm.id,
        nCtx,
        threads: num(env.BOAR_BENCH_THREADS) ?? "app default (auto)",
        retrieveK: num(env.BOAR_BENCH_K) ?? "app default",
        kvCache: env.BOAR_BENCH_KV || "app default",
        contextTokens: num(env.BOAR_BENCH_CONTEXT_TOKENS) ?? "app default",
        wikiPack: env.BOAR_BENCH_WIKI === "1" ? path.basename(wikiShard) : null,
        gpuLayers: num(env.BOAR_GPU_LAYERS) ?? "auto",
        seed: num(env.BOAR_BENCH_SEED) ?? 42,
        backend: state.backend,
        cpu: os.cpus()[0]?.model,
        totalRamGB: round(os.totalmem() / 1024 ** 3),
        node: process.version,
        evalSetVersion: EVAL_SET_VERSION,
        scoreVersion: SCORE_VERSION,
        questions: set.map((q) => q.id),
      },
      speed: {
        embedLoadMs: round(embedLoadMs, 0),
        indexMs: round(indexMs, 0),
        indexDocs,
        llmLoadMs: round(llmLoadMs, 0),
        decodeTokPerSec: round(median(dec.map((d) => d.tokPerSec))),
        microTtftMs: round(median(dec.map((d) => d.ttftMs)), 0),
        prefillTokPerSec: round(median(pre.map((p) => p.tokPerSec))),
        prefillTokens: median(pre.map((p) => p.tokens)),
        prefillMs: round(median(pre.map((p) => p.ms)), 0),
        answerTtftMs: round(median(answers.filter((a) => a.outcome === "success").map((a) => a.ttftMs!)), 0),
        answerTotalMs: round(median(answers.filter((a) => a.outcome === "success").map((a) => a.totalMs!)), 0),
        answerTokPerSec: round(median(answers.filter((a) => (a.tokens ?? 0) >= 16).map((a) => a.tokPerSec!))),
        answerPrefillMs: round(median(answers.map((a) => a.prefillMs!)), 0),
        micro,
      },
      memory: {
        peakRssMB: round(peakRss / MB, 0),
        vramBaseMB: round(vramBase / MB, 0),
        vramAfterLoadMB: round(vramAfterLoad / MB, 0),
        peakVramMB: round(peakVram / MB, 0),
      },
      retrieval,
      quality: {
        scoreV1: score.score,
        scoreParts: { speed: round(score.speed, 3), reliability: round(score.reliability, 3), retrieval: round(score.retrieval, 3) },
        completed: score.completed,
        answers: score.answers,
        declined: answers.filter((a) => a.declined).length,
        retrievalHits: `${score.retrievalHits}/${score.retrievalQuestions}`,
        factsPassed: graded.filter((a) => a.fact).length,
        factsTotal: graded.length,
        factsRate: graded.length ? round(graded.filter((a) => a.fact).length / graded.length, 3) : undefined,
        shouldAnswer: answers.filter((a) => a.expect === "answer").length,
        falseDeclines: answers.filter((a) => a.falseDecline).length,
        shouldDecline: answers.filter((a) => a.expect === "decline").length,
        falseAnswers: answers.filter((a) => a.falseAnswer).length,
        wrongAnswers: answers.filter((a) => a.wrongAnswer).length,
        // Which check declined, by reason code (src/routing/answer.ts): the diagnosis of every decline.
        declineReasons: answers
          .filter((a) => a.declined)
          .map((a) => a.reasonCodes.find((c: string) => c.startsWith("grounding:") && c.includes("declined")) ?? "other")
          .reduce((m: Record<string, number>, c: string) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {}),
      },
      answers,
    };
    if (OUT) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    }
    await llamaEngine.unload();
    await embeddingEngine.unload();
  } finally {
    clearInterval(sampler);
    try {
      await (await (await import("../../src/rag/db")).getDb()).closeAsync();
    } catch {}
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (e: any) {
      console.warn(`[bench] could not remove ${root} (${e?.code}); the next run removes it`);
    }
  }
});
