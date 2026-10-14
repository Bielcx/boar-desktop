/**
 * llama.rn's API, re-implemented in the Electron main process on node-llama-cpp (root node_modules).
 * Plain Node module (erasable TS only): runs under `node file.ts`, no Electron import. The handler
 * (../handlers/llama.rn.ts) only wires IPC channels to these functions; everything in and out is
 * structured-cloneable, in llama.rn's shapes (desktop/src/shims/llama.rn.ts re-exposes them).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatHistoryItem,
  ChatWrapper,
  Llama,
  LlamaContext as NlcContext,
  LlamaContextSequence,
  LlamaEmbeddingContext,
  LlamaModel,
} from "node-llama-cpp";
import { inside, localPathOf } from "../storage/safePath";

type Nlc = typeof import("node-llama-cpp");
let nlcP: Promise<Nlc> | null = null;
// ESM-only package: a dynamic import works from CJS (Electron main bundle) and ESM alike.
const nlc = () => (nlcP ??= import("node-llama-cpp"));

let llamaP: Promise<Llama> | null = null;
/** One Llama for the process: GPU backend picked by node-llama-cpp (CUDA/Vulkan/Metal), CPU build if none starts. */
export function getLlamaInstance(): Promise<Llama> {
  return (llamaP ??= (async () => {
    const { getLlama, LlamaLogLevel } = await nlc();
    const common = { build: "never" as const, logLevel: LlamaLogLevel.error };
    try {
      return await getLlama({ ...common, gpu: "auto" });
    } catch (e) {
      console.warn("[llama] GPU build failed to start, using CPU:", (e as Error)?.message ?? e);
      return getLlama({ ...common, gpu: false });
    }
  })());
}

// ---- paths -------------------------------------------------------------------------------------------

/**
 * file:// URI (what the app passes) -> real path, refused unless inside one of `roots`. The text check runs before any
 * disk access, so a network path (file://host/...) is never opened.
 */
export function resolveModelPath(uri: string, roots: Array<string | undefined>): string {
  const p = localPathOf(uri);
  const textRoots = roots.filter((r): r is string => !!r).map((r) => path.resolve(r));
  if (!textRoots.some((r) => inside(r, p) && path.relative(r, p) !== "")) {
    throw new Error(`Refusing model path outside the app's data/models dirs: ${p}`);
  }
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    throw new Error(`Model not found: ${p}`);
  }
  // Again on real paths: a link inside a root that points outside doesn't count.
  const realInside = textRoots.some((root) => {
    let r: string;
    try {
      r = fs.realpathSync(root);
    } catch {
      return false;
    }
    return inside(r, real) && path.relative(r, real) !== "";
  });
  if (!realInside) throw new Error(`Refusing model path outside the app's data/models dirs: ${real}`);
  return real;
}

// ---- contexts ----------------------------------------------------------------------------------------

/** Subset of llama.rn's ContextParams the app passes (LlamaEngine.ts, embed.ts, initFallback.ts). */
export interface InitParams {
  model: string;
  n_ctx?: number;
  n_threads?: number;
  n_batch?: number;
  n_gpu_layers?: number;
  use_mmap?: boolean;
  use_mlock?: boolean;
  embedding?: boolean;
  devices?: string[];
  flash_attn_type?: "auto" | "on" | "off";
}

interface Entry {
  model: LlamaModel;
  context?: NlcContext;
  sequence?: LlamaContextSequence;
  embedder?: LlamaEmbeddingContext;
  wrappers: Map<string, ChatWrapper>;
  abort: AbortController | null;
  running: Promise<unknown> | null;
}

const entries = new Map<number, Entry>();
let nextId = 1;

function entry(id: number): Entry {
  const e = entries.get(id);
  if (!e) throw new Error(`Context ${id} not found (released?)`);
  return e;
}

/** Returns llama.rn's NativeLlamaContext shape (contextId, gpu, reasonNoGPU, devices, model{...}). */
export async function initContext(params: InitParams, roots: Array<string | undefined>, onProgress?: (pct: number) => void) {
  const modelPath = resolveModelPath(params.model, roots);
  const llama = await getLlamaInstance();
  // The app always passes n_gpu_layers: 0 (tuned for phones); on desktop the GPU decides. Only an explicit
  // CPU device list (initFallback's retry) forces CPU.
  const cpuOnly = llama.gpu === false || (params.devices?.length ? params.devices.every((d) => /cpu/i.test(d)) : false);

  let lastPct = -1;
  const progress = (p: number) => {
    const pct = Math.round(p * 100);
    if (pct !== lastPct) onProgress?.((lastPct = pct)); // node-llama-cpp repeats values; one IPC event per step
  };
  const load = async (gpu: boolean): Promise<Entry> => {
    lastPct = -1;
    const model = await llama.loadModel({
      modelPath,
      // BOAR_GPU_LAYERS: a fixed layer count instead of "auto", for the benchmark (desktop/bench); unset in the app.
      gpuLayers: gpu ? Number(process.env.BOAR_GPU_LAYERS) || "auto" : 0,
      useMmap: params.use_mmap ?? true,
      useMlock: params.use_mlock ?? false,
      onLoadProgress: onProgress ? progress : undefined,
    });
    try {
      const opts = {
        contextSize: params.n_ctx ?? 512, // llama.rn's default
        threads: params.n_threads,
        batchSize: params.n_batch,
        // Unset or "auto" -> node-llama-cpp's "auto" (on where the backend supports it); only an explicit "off" turns it off.
        flashAttention: params.flash_attn_type === "off" ? false : params.flash_attn_type === "on" ? true : ("auto" as const),
      };
      if (params.embedding) {
        return { model, embedder: await model.createEmbeddingContext(opts), wrappers: new Map(), abort: null, running: null };
      }
      const context = await model.createContext({ ...opts, sequences: 1 });
      return { model, context, sequence: context.getSequence(), wrappers: new Map(), abort: null, running: null };
    } catch (e) {
      await model.dispose();
      throw e;
    }
  };

  let e: Entry;
  let reasonNoGPU = cpuOnly ? "CPU requested" : "";
  try {
    e = await load(!cpuOnly);
  } catch (err) {
    if (cpuOnly) throw err;
    // Mirrors initFallback.ts: a GPU that fails to take the model or its context retries once on CPU.
    reasonNoGPU = String((err as Error)?.message ?? err);
    console.warn(`[llama] GPU load failed (${reasonNoGPU}); retrying on CPU`);
    e = await load(false);
  }
  const contextId = nextId++;
  entries.set(contextId, e);

  const meta = e.model.fileInfo.metadata as any;
  const hasTemplate = typeof meta?.tokenizer?.chat_template === "string";
  const gpu = llama.gpu !== false && e.model.gpuLayers > 0;
  const deviceNames = gpu ? await llama.getGpuDeviceNames().catch(() => [] as string[]) : [];
  return {
    contextId,
    gpu,
    reasonNoGPU: gpu ? "" : reasonNoGPU || "No GPU backend",
    devices: gpu ? deviceNames : ["CPU"],
    model: {
      desc: `${meta?.general?.architecture ?? "?"} ${meta?.general?.name ?? ""}`.trim(),
      size: e.model.size,
      nEmbd: e.model.embeddingVectorSize,
      nParams: 0, // ponytail: not exposed by node-llama-cpp; the app doesn't read it
      is_recurrent: false,
      is_hybrid: false,
      chatTemplates: {
        llamaChat: true,
        jinja: {
          default: hasTemplate,
          defaultCaps: { tools: false, toolCalls: false, systemRole: true, parallelToolCalls: false },
          toolUse: false,
        },
      },
      metadata: flattenMetadata(meta),
      isChatTemplateSupported: true,
    },
  };
}

// ---- completion --------------------------------------------------------------------------------------

export interface ChatMessage {
  role: string;
  content: string;
}

/** Subset of llama.rn's CompletionParams the app passes (LlamaEngine.generateNow / warmNow), plus samplers. */
export interface CompletionParams {
  prompt?: string;
  messages?: ChatMessage[];
  jinja?: boolean;
  n_predict?: number;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  seed?: number;
  penalty_repeat?: number;
  penalty_last_n?: number;
  stop?: string[];
  thinking_budget_tokens?: number;
  thinking_start_tag?: string;
  thinking_end_tag?: string;
  enable_thinking?: boolean;
}

function toHistory(messages: ChatMessage[]): ChatHistoryItem[] {
  return messages.map((m): ChatHistoryItem =>
    m.role === "system"
      ? { type: "system", text: m.content }
      : m.role === "assistant"
        ? { type: "model", response: [m.content] }
        : { type: "user", text: m.content }
  );
}

async function chatWrapperFor(e: Entry, enableThinking: boolean): Promise<ChatWrapper> {
  const key = enableThinking ? "default" : "no-thinking";
  let w = e.wrappers.get(key);
  if (!w) {
    const { resolveChatWrapper } = await nlc();
    // "auto": a specialized wrapper only when it renders identically to the GGUF's own Jinja template,
    // else the Jinja template itself; models without a template get node-llama-cpp's best guess.
    w = resolveChatWrapper(e.model, {
      customWrapperSettings: enableThinking
        ? {}
        : { jinjaTemplate: { additionalRenderParameters: { enable_thinking: false } }, qwen: { thoughts: "discourage" } },
    });
    e.wrappers.set(key, w);
  }
  return w;
}

const isAbort = (err: unknown) => (err as Error)?.name === "AbortError" || /abort/i.test(String((err as Error)?.message ?? err));

/**
 * llama.rn's context.completion: streams each piece through onToken({ token }) and resolves with a
 * NativeCompletionResult-shaped object. One completion per context at a time (llama.rn: "Context is busy").
 * The sequence keeps its KV cache between calls; node-llama-cpp re-evaluates only from the first token that
 * differs, the prefix reuse LlamaEngine's setAnswerPrefix relies on.
 */
export async function completion(id: number, params: CompletionParams, onToken?: (data: { token: string }) => void) {
  const e = entry(id);
  if (!e.sequence) throw new Error("This context was created with embedding: true");
  if (e.running) throw new Error("Context is busy");
  const abort = new AbortController();
  e.abort = abort;
  const run = generate(e, e.sequence, params, abort.signal, onToken);
  e.running = run;
  try {
    return await run;
  } finally {
    e.abort = null;
    e.running = null;
  }
}

async function generate(
  e: Entry,
  sequence: LlamaContextSequence,
  params: CompletionParams,
  signal: AbortSignal,
  onToken?: (data: { token: string }) => void
) {
  const { LlamaChat, LlamaCompletion } = await nlc();
  // ponytail: n_predict 0 (prefill only) generates one token and drops it; node-llama-cpp has no 0 (it means
  // "unlimited"). The extra token sits after the prefix, so the next prompt still reuses the whole prefix.
  const prefillOnly = params.n_predict === 0;
  const maxTokens = prefillOnly ? 1 : params.n_predict && params.n_predict > 0 ? params.n_predict : undefined;
  const sampling = {
    signal,
    stopOnAbortSignal: true,
    maxTokens,
    temperature: params.temperature ?? 0.8,
    topK: params.top_k ?? 40,
    topP: params.top_p ?? 0.95,
    minP: params.min_p ?? 0.05,
    seed: params.seed != null && params.seed >= 0 ? params.seed : undefined,
    // llama.rn/llama.cpp default penalty_repeat is 1.0 (off); node-llama-cpp's default is on.
    repeatPenalty:
      params.penalty_repeat && params.penalty_repeat !== 1
        ? { penalty: params.penalty_repeat, lastTokens: params.penalty_last_n ?? 64 }
        : (false as const),
    customStopTriggers: params.stop?.filter((s) => s.length > 0),
  };

  const meter = sequence.tokenMeter;
  const in0 = meter.usedInputTokens;
  const out0 = meter.usedOutputTokens;
  const t0 = performance.now();
  let tFirst = 0;
  let text = "";
  const emit = (piece: string) => {
    if (!piece || prefillOnly) return;
    if (!tFirst) tFirst = performance.now();
    text += piece;
    onToken?.({ token: piece });
  };

  let content = "";
  let reasoning = "";
  let stopReason = "eogToken";
  let stoppingWord = "";
  try {
    if (params.messages) {
      const chat = new LlamaChat({ contextSequence: sequence, chatWrapper: await chatWrapperFor(e, params.enable_thinking !== false) });
      const startTag = params.thinking_start_tag ?? "<think>";
      const endTag = params.thinking_end_tag ?? "</think>";
      try {
        const res = await chat.generateResponse(toHistory(params.messages), {
          ...sampling,
          budgets: params.thinking_budget_tokens ? { thoughtTokens: params.thinking_budget_tokens } : undefined,
          // llama.rn's raw token stream carries the reasoning block inline; the app parses the tags itself.
          onResponseChunk: (c) => {
            if (c.type === "segment") {
              if (c.segmentType !== "thought") return;
              if (c.segmentStartTime) emit(startTag);
              reasoning += c.text;
              emit(c.text);
              if (c.segmentEndTime) emit(endTag);
            } else {
              content += c.text;
              emit(c.text);
            }
          },
        });
        content = res.response;
        stopReason = res.metadata.stopReason;
        if (res.metadata.stopReason === "customStopTrigger") stoppingWord = res.metadata.customStopTrigger.join("");
      } finally {
        chat.dispose({ disposeSequence: false });
      }
    } else {
      const comp = new LlamaCompletion({ contextSequence: sequence });
      try {
        const res = await comp.generateCompletionWithMeta(params.prompt ?? "", { ...sampling, onTextChunk: emit });
        content = res.response;
        stopReason = res.metadata.stopReason;
        if (res.metadata.stopReason === "customStopTrigger") stoppingWord = res.metadata.customStopTrigger.join("");
      } finally {
        comp.dispose({ disposeSequence: false });
      }
    }
  } catch (err) {
    // A stop before the first token (prompt still evaluating) throws instead of returning; llama.rn resolves.
    if (!signal.aborted || !isAbort(err)) throw err;
    stopReason = "abort";
  }

  const tEnd = performance.now();
  const promptN = meter.usedInputTokens - in0;
  const predictedN = prefillOnly ? 0 : meter.usedOutputTokens - out0;
  const promptMs = (tFirst || tEnd) - t0;
  const predictedMs = tFirst ? tEnd - tFirst : 0;
  // ponytail: cached = context length minus what was evaluated now; approximate by a token or two.
  const cached = Math.max(0, sequence.nextTokenIndex - promptN - (meter.usedOutputTokens - out0));
  const per = (n: number, ms: number) => ({ perToken: n ? ms / n : 0, perSecond: ms ? (n * 1000) / ms : 0 });
  const p = per(promptN, promptMs);
  const g = per(predictedN, predictedMs);
  return {
    text: prefillOnly ? "" : text || content,
    content: prefillOnly ? "" : content,
    reasoning_content: reasoning,
    tool_calls: [],
    chat_format: 0,
    tokens_predicted: predictedN,
    tokens_evaluated: promptN,
    tokens_cached: cached,
    draft_tokens: 0,
    draft_tokens_accepted: 0,
    truncated: false,
    stopped_eos: stopReason === "eogToken",
    stopped_word: stoppingWord,
    stopped_limit: stopReason === "maxTokens" ? 1 : 0,
    stopping_word: stoppingWord,
    context_full: false,
    interrupted: stopReason === "abort",
    timings: {
      cache_n: cached,
      prompt_n: promptN,
      prompt_ms: promptMs,
      prompt_per_token_ms: p.perToken,
      prompt_per_second: p.perSecond,
      predicted_n: predictedN,
      predicted_ms: predictedMs,
      predicted_per_token_ms: g.perToken,
      predicted_per_second: g.perSecond,
    },
  };
}

/** Stops the running completion; it resolves normally with the text so far (llama.rn semantics). */
export async function stopCompletion(id: number): Promise<void> {
  entries.get(id)?.abort?.abort();
}

// ---- tokens / embeddings -----------------------------------------------------------------------------

export async function tokenize(id: number, text: string) {
  const tokens = entry(id).model.tokenize(text) as number[];
  return { tokens: [...tokens], has_media: false, bitmap_hashes: [], chunk_pos: [], chunk_pos_media: [] };
}

export async function detokenize(id: number, tokens: number[]): Promise<string> {
  return entry(id).model.detokenize(tokens as any);
}

/** llama.rn's embedding: { embedding: number[] }, L2-normalized (embd_normalize 2, llama.cpp's default). */
export async function embedding(id: number, text: string, params?: { embd_normalize?: number }) {
  const e = entry(id);
  if (!e.embedder) throw new Error("Context was not created with embedding: true");
  const v = [...(await e.embedder.getEmbeddingFor(text)).vector];
  if ((params?.embd_normalize ?? 2) === 2) {
    const norm = Math.hypot(...v) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
  return { embedding: v };
}

// ---- lifecycle ---------------------------------------------------------------------------------------

export async function release(id: number): Promise<void> {
  const e = entries.get(id);
  if (!e) return;
  entries.delete(id);
  e.abort?.abort();
  await e.running?.catch(() => {});
  await e.embedder?.dispose();
  await e.context?.dispose();
  await e.model.dispose();
}

export async function releaseAll(): Promise<void> {
  await Promise.all([...entries.keys()].map(release));
}

// ---- model info / devices ----------------------------------------------------------------------------

/** GGUF metadata as llama.rn's loadLlamaModelInfo returns it: flat "a.b.c" -> string; arrays left out. */
export function flattenMetadata(meta: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (meta == null || typeof meta !== "object") return out;
  for (const [k, v] of Object.entries(meta)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) continue;
    if (v !== null && typeof v === "object") flattenMetadata(v, key, out);
    else if (v !== undefined) out[key] = String(v);
  }
  return out;
}

export async function loadModelInfo(uriOrPath: string, roots: Array<string | undefined>): Promise<Record<string, string>> {
  const { readGgufFileInfo } = await nlc();
  const info = await readGgufFileInfo(resolveModelPath(uriOrPath, roots), { readTensorInfo: false });
  return flattenMetadata(info.metadata);
}

/** llama.rn's NativeBackendDeviceInfo list. */
export async function backendDevices() {
  const llama = await getLlamaInstance();
  const devices: Array<{ backend: string; type: string; deviceName: string; maxMemorySize: number }> = [];
  if (llama.gpu !== false) {
    const vram = await llama.getVramState().catch(() => ({ total: 0 }));
    for (const name of await llama.getGpuDeviceNames().catch(() => [] as string[])) {
      devices.push({ backend: String(llama.gpu).toUpperCase(), type: "gpu", deviceName: name, maxMemorySize: vram.total });
    }
  }
  devices.push({ backend: "CPU", type: "cpu", deviceName: "CPU", maxMemorySize: os.totalmem() });
  return devices;
}
