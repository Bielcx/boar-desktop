// Desktop shim for "llama.rn": the subset of its API the app uses (src/inference/LlamaEngine.ts, src/rag/embed.ts),
// run by the Electron main process (desktop/src/main/llama/engine.ts) over window.boarNative. See shared/bridge.ts.
import { native } from "../shared/bridge";

export type TokenData = { token: string; content?: string; reasoning_content?: string; accumulated_text?: string };

export type NativeCompletionResultTimings = {
  cache_n: number;
  prompt_n: number;
  prompt_ms: number;
  prompt_per_token_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_token_ms: number;
  predicted_per_second: number;
};

export type NativeCompletionResult = {
  text: string;
  content: string;
  reasoning_content: string;
  tool_calls: Array<{ type: "function"; function: { name: string; arguments: string }; id?: string }>;
  chat_format: number;
  tokens_predicted: number;
  tokens_evaluated: number;
  tokens_cached: number;
  draft_tokens: number;
  draft_tokens_accepted: number;
  truncated: boolean;
  stopped_eos: boolean;
  stopped_word: string;
  stopped_limit: number;
  stopping_word: string;
  context_full: boolean;
  interrupted: boolean;
  timings: NativeCompletionResultTimings;
};

export type NativeTokenizeResult = {
  tokens: number[];
  has_media: boolean;
  bitmap_hashes: number[];
  chunk_pos: number[];
  chunk_pos_media: number[];
};
export type NativeEmbeddingResult = { embedding: number[] };
export type EmbeddingParams = { embd_normalize?: number };
export type NativeBackendDeviceInfo = {
  backend: string;
  type: string;
  deviceName: string;
  maxMemorySize: number;
  metadata?: Record<string, any>;
};

export type ContextParams = {
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
};

export type RNLlamaOAICompatibleMessage = { role: string; content: string };

export type CompletionParams = {
  prompt?: string;
  messages?: RNLlamaOAICompatibleMessage[];
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
  thinking_budget_message?: string;
  enable_thinking?: boolean;
};

type NativeLlamaContext = {
  contextId: number;
  gpu: boolean;
  reasonNoGPU: string;
  devices: string[];
  model: {
    desc: string;
    size: number;
    nEmbd: number;
    nParams: number;
    chatTemplates: { llamaChat: boolean; jinja: { default: boolean } };
    metadata: Object;
    isChatTemplateSupported: boolean;
  };
};

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${++seq}`;

export class LlamaContext {
  id: number;
  gpu: boolean;
  reasonNoGPU: string;
  devices: string[];
  model: NativeLlamaContext["model"];

  constructor({ contextId, gpu, reasonNoGPU, devices, model }: NativeLlamaContext) {
    this.id = contextId;
    this.gpu = gpu;
    this.reasonNoGPU = reasonNoGPU;
    this.devices = devices;
    this.model = model;
  }

  isLlamaChatSupported(): boolean {
    return this.model.chatTemplates.llamaChat;
  }

  /** Whether the GGUF ships a Jinja chat template (tokenizer.chat_template). */
  isJinjaSupported(): boolean {
    return this.model.chatTemplates.jinja.default;
  }

  /** Tokens stream as "llama.rn:token" events tagged with this call's request id. */
  async completion(params: CompletionParams, callback?: (data: TokenData) => void): Promise<NativeCompletionResult> {
    const requestId = newId();
    const off = callback
      ? native().on("llama.rn:token", (rid, data) => {
          if (rid === requestId) callback(data as TokenData);
        })
      : null;
    try {
      // Main ignores thinking_budget_message: node-llama-cpp has no equivalent (see desktop/docs/02-motor.md).
      return await native().invoke<NativeCompletionResult>("llama.rn:completion", this.id, requestId, params);
    } finally {
      off?.();
    }
  }

  stopCompletion(): Promise<void> {
    return native().invoke("llama.rn:stopCompletion", this.id);
  }

  tokenize(text: string): Promise<NativeTokenizeResult> {
    return native().invoke("llama.rn:tokenize", this.id, text);
  }

  detokenize(tokens: number[]): Promise<string> {
    return native().invoke("llama.rn:detokenize", this.id, tokens);
  }

  embedding(text: string, params?: EmbeddingParams): Promise<NativeEmbeddingResult> {
    return native().invoke("llama.rn:embedding", this.id, text, params);
  }

  release(): Promise<void> {
    return native().invoke("llama.rn:release", this.id);
  }
}

/** onProgress gets 0-100, like llama.rn. */
export async function initLlama(params: ContextParams, onProgress?: (progress: number) => void): Promise<LlamaContext> {
  const progressId = onProgress ? newId() : undefined;
  const off = onProgress
    ? native().on("llama.rn:progress", (pid, pct) => {
        if (pid === progressId) onProgress(pct as number);
      })
    : null;
  try {
    return new LlamaContext(await native().invoke<NativeLlamaContext>("llama.rn:initLlama", params, progressId));
  } finally {
    off?.();
  }
}

/** GGUF header as a flat key -> string map (arrays left out). */
export function loadLlamaModelInfo(model: string): Promise<Object> {
  return native().invoke("llama.rn:loadLlamaModelInfo", model);
}

export function getBackendDevicesInfo(): Promise<NativeBackendDeviceInfo[]> {
  return native().invoke("llama.rn:getBackendDevicesInfo");
}

export function releaseAllLlama(): Promise<void> {
  return native().invoke("llama.rn:releaseAll");
}
