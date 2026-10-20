/**
 * llama.rn on desktop, end to end in one process: shim -> loopback IPC -> handler -> node-llama-cpp.
 * Model tests need BOAR_TEST_MODELS_DIR holding the app's files (src/models/manifest.ts):
 *   qwen2.5-1.5b-instruct-q4km.gguf and embedding.gguf (bge-small-en-v1.5 Q8_0). Skipped otherwise.
 *
 *   BOAR_TEST_MODELS_DIR=C:/Users/bielc/Dev/boar-shared-models npm test -- test/llama.rn.test.ts   (in desktop/)
 *
 * "llama.rn" is mocked to this shim, so the real src/inference/LlamaEngine.ts and src/rag/embed.ts run on it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loopback } from "../src/testing/loopback";
import { register } from "../src/main/handlers/llama.rn";
import { resolveModelPath } from "../src/main/llama/engine";

const { MODELS, modelsUri } = vi.hoisted(() => {
  const MODELS = process.env.BOAR_TEST_MODELS_DIR ?? "";
  // pathToFileURL isn't importable in a hoisted block; Windows or POSIX path -> file:/// URI ending in "/".
  const modelsUri = MODELS ? "file:///" + MODELS.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/?$/, "/") : "file:///missing/";
  return { MODELS, modelsUri };
});
const LLM = "qwen2.5-1.5b-instruct-q4km.gguf";
const EMB = "embedding.gguf";
const haveModels = !!MODELS && fs.existsSync(path.join(MODELS, LLM)) && fs.existsSync(path.join(MODELS, EMB));

vi.mock("llama.rn", () => import("../src/shims/llama.rn"));
vi.mock("react-native", () => ({ Platform: { OS: "windows" } }));
vi.mock("ram-monitor", async () => {
  const os = await import("node:os");
  return {
    getDeviceTotalRamBytes: () => os.totalmem(),
    getAvailableRamBytes: () => os.freemem(),
    getMemoryInfo: () => ({ rssBytes: process.memoryUsage().rss }),
  };
});
vi.mock("expo-file-system/legacy", async () => {
  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  return {
    documentDirectory: modelsUri,
    getInfoAsync: async (uri: string) => {
      try {
        return { exists: true, size: fs.statSync(fileURLToPath(uri)).size };
      } catch {
        return { exists: false };
      }
    },
  };
});

import * as llama from "../src/shims/llama.rn";
import { LlamaEngine } from "../../src/inference/LlamaEngine";
import { EmbeddingEngine } from "../../src/rag/embed";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "boar-llama-"));
const T = 180_000;
const chat = [
  { role: "system", content: "You are a concise assistant." },
  { role: "user", content: "Count from 1 to 20, separated by commas." },
];

beforeAll(() => {
  if (MODELS) process.env.BOAR_MODELS_DIR = MODELS;
  const { native, ctx } = loopback(dataDir);
  register(ctx);
  (globalThis as any).window = { boarNative: native };
});

describe("model path guard", () => {
  it("accepts files inside a root and refuses everything else", () => {
    const inside = path.join(dataDir, "m.gguf");
    fs.writeFileSync(inside, "x");
    expect(resolveModelPath(pathToFileURL(inside).href, [dataDir])).toBe(fs.realpathSync(inside));
    expect(() => resolveModelPath(pathToFileURL(inside).href, [path.join(dataDir, "other")])).toThrow(/Refusing/);
    const outside = path.join(os.tmpdir(), `boar-outside-${process.pid}.gguf`);
    fs.writeFileSync(outside, "x");
    expect(() => resolveModelPath(pathToFileURL(path.join(dataDir, "..", path.basename(outside))).href, [dataDir])).toThrow(/Refusing/);
    fs.rmSync(outside);
    expect(() => resolveModelPath(pathToFileURL(dataDir).href, [dataDir])).toThrow(/Refusing/); // the root itself is not a model
    expect(() => resolveModelPath(inside, [dataDir])).toThrow(/not a file:\/\/ URI/); // plain paths aren't accepted
  });

  it("refuses network paths before touching the disk (no SMB connection, no NTLM hash sent)", () => {
    const spy = vi.spyOn(fs, "realpathSync");
    // Windows turns the host into a UNC path (refused here); Node on Linux and macOS refuses a host in a file URL.
    expect(() => resolveModelPath("file://attacker.example/share/m.gguf", [dataDir])).toThrow(/network or device path|bad file URI/);
    expect(() => resolveModelPath("file:////attacker.example/share/m.gguf", [dataDir])).toThrow(/network or device path|bad file URI/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects a model outside the roots over IPC too", async () => {
    await expect(llama.initLlama({ model: pathToFileURL(path.join(os.homedir(), "x.gguf")).href })).rejects.toThrow();
  });
});

describe.skipIf(!haveModels)("llama.rn shim over node-llama-cpp", () => {
  let ctx: llama.LlamaContext;
  let emb: llama.LlamaContext;

  afterAll(async () => {
    await ctx?.release();
    await emb?.release();
  });

  it("initLlama loads the LLM with progress 0-100", async () => {
    const progress: number[] = [];
    ctx = await llama.initLlama(
      { model: modelsUri + LLM, n_ctx: 2048, n_threads: 4, n_gpu_layers: 0, use_mmap: true },
      (p) => progress.push(p)
    );
    expect(progress.at(-1)).toBe(100);
    expect(ctx.isJinjaSupported()).toBe(true);
    console.log(`[llama test] LLM backend: ${ctx.gpu ? `GPU ${ctx.devices.join(", ")}` : `CPU (${ctx.reasonNoGPU})`}`);
    console.log("[llama test] devices:", JSON.stringify(await llama.getBackendDevicesInfo()));
  }, T);

  it("streams a messages+jinja completion token by token", async () => {
    const pieces: string[] = [];
    let resolved = false;
    let tokensBeforeResolve = 0;
    const p = ctx.completion({ messages: chat, jinja: true, n_predict: 64, temperature: 0, stop: [] }, (d) => {
      pieces.push(d.token);
      if (!resolved) tokensBeforeResolve++;
    });
    const r = await p;
    resolved = true;
    expect(tokensBeforeResolve).toBeGreaterThan(5);
    expect(pieces.join("")).toBe(r.text);
    expect(r.text).toMatch(/1,\s*2,\s*3/);
    expect(r.timings.prompt_n).toBeGreaterThan(10);
    expect(r.timings.predicted_n).toBeGreaterThan(5);
    expect(r.timings.predicted_ms).toBeGreaterThan(0);
    expect(typeof r.tokens_cached).toBe("number");
    console.log(
      `[llama test] completion: ${r.timings.predicted_n} tokens, ${r.timings.predicted_per_second.toFixed(1)} tok/s; ` +
        `prompt ${r.timings.prompt_n} tokens in ${r.timings.prompt_ms.toFixed(0)} ms`
    );
  }, T);

  it("a plain prompt honors stop strings", async () => {
    const r = await ctx.completion({ prompt: "Q: list three colors.\nA: red, green, blue\nQ:", n_predict: 40, temperature: 0, stop: ["\n"] });
    expect(r.text).not.toContain("\n");
  }, T);

  it("stopCompletion ends a running generation; the promise resolves with what was generated", async () => {
    let n = 0;
    const p = ctx.completion(
      { messages: [{ role: "user", content: "Write a very long story about a boar." }], jinja: true, n_predict: 500 },
      () => {
        if (++n === 5) void ctx.stopCompletion();
      }
    );
    const r = await p;
    expect(r.interrupted).toBe(true);
    expect(r.timings.predicted_n).toBeLessThan(50);
    expect(r.text.length).toBeGreaterThan(0);
  }, T);

  it("n_predict 0 prefills the prompt and the next completion reuses it (KV prefix cache)", async () => {
    const warm = await ctx.completion({ messages: [chat[0], { role: "user", content: "" }], jinja: true, n_predict: 0 });
    expect(warm.text).toBe("");
    const r = await ctx.completion({ messages: chat, jinja: true, n_predict: 4, temperature: 0 });
    expect(r.tokens_cached).toBeGreaterThan(5);
  }, T);

  it("tokenize / detokenize", async () => {
    const { tokens } = await ctx.tokenize("Hello world");
    expect(tokens.length).toBeGreaterThan(0);
    expect(await ctx.detokenize(tokens)).toBe("Hello world");
  }, T);

  it("embedding returns a normalized 384-dim vector", async () => {
    emb = await llama.initLlama({ model: modelsUri + EMB, embedding: true, n_ctx: 512, n_threads: 2 });
    const { embedding } = await emb.embedding("The boar is a wild pig.");
    expect(embedding).toHaveLength(384);
    expect(Math.hypot(...embedding)).toBeCloseTo(1, 3);
  }, T);

  it("loadLlamaModelInfo returns the flat header map", async () => {
    const info = (await llama.loadLlamaModelInfo(modelsUri + LLM)) as Record<string, string>;
    expect(info["general.architecture"]).toBe("qwen2");
    expect(info["qwen2.block_count"]).toBe("28");
  }, T);

  it("release frees the context; later calls fail", async () => {
    await emb.release();
    await expect(emb.embedding("x")).rejects.toThrow(/not found/);
    emb = undefined as any;
  }, T);
});

describe.skipIf(!haveModels)("the real LlamaEngine and EmbeddingEngine on the shim", () => {
  const engine = new LlamaEngine(null);
  afterAll(() => engine.unload());

  it("loads, streams, stops, reuses the answer prefix, unloads", async () => {
    const progress: number[] = [];
    const res = await engine.load(LLM, { nCtx: 2048, meta: { modelId: "q", label: "Qwen" }, onProgress: (f) => progress.push(f) });
    expect(engine.isLoaded).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(res.fit).not.toBeNull(); // header + RAM readouts reached memoryFit
    expect(engine.hasEmbeddedChatTemplate()).toBe(true);

    const pieces: string[] = [];
    let timings: any;
    const text = await engine.generate({ messages: chat, nPredict: 48, temperature: 0, onToken: (t) => pieces.push(t), onTimings: (t) => (timings = t) });
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.join("")).toBe(text);
    expect(timings.predictedTokens).toBeGreaterThan(5);
    console.log(`[llama test] LlamaEngine.generate: ${((timings.predictedTokens * 1000) / timings.predictedMs).toFixed(1)} tok/s`);

    // Stop mid-generation: generate() resolves with the partial text.
    let n = 0;
    const partial = await engine.generate({
      messages: [{ role: "user", content: "Write a very long story about a boar." }],
      nPredict: 500,
      onToken: () => {
        if (++n === 5) void engine.stop();
      },
    });
    expect(partial.length).toBeGreaterThan(0);
    expect(n).toBeLessThan(50);

    // setAnswerPrefix: the engine prefills the system prompt (n_predict 0); an answer then reuses it.
    engine.setAnswerPrefix({ system: chat[0].content, prompt: "" });
    await new Promise((r) => setTimeout(r, 3000));
    let cached = 0;
    await engine.generate({ messages: chat, nPredict: 4, onTimings: (t) => (cached = t.cachedTokens ?? 0) });
    expect(cached).toBeGreaterThan(5);

    await engine.unload();
    expect(engine.isLoaded).toBe(false);
  }, T);

  it("EmbeddingEngine.embed returns a 384-dim Float32Array", async () => {
    const e = new EmbeddingEngine();
    await e.load(EMB);
    const v = await e.embed("hello");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(384);
    await e.unload();
  }, T);
});
