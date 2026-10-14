import { Platform } from "react-native";
import { LlamaContext, getBackendDevicesInfo, initLlama } from "llama.rn";
import * as FileSystem from "expo-file-system/legacy";
import { cpuDeviceNames, initWithCpuFallback } from "../inference/initFallback";

/**
 * Wraps a small local embedding model (GGUF, <300MB) via llama.rn's
 * embedding mode. Kept as a separate, lighter-weight context from the main
 * generation LLM so it can stay resident cheaply for fast retrieval without
 * competing with the primary model's RAM budget.
 */
export class EmbeddingEngine {
  private context: LlamaContext | null = null;
  private modelFilename: string | null = null;
  // llama.rn rejects a call on a context that's still working ("Context is
  // busy"), so loads, embeddings and unloads run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  load(modelFilename: string): Promise<void> {
    return this.enqueue(() => this.loadNow(modelFilename));
  }

  private async loadNow(modelFilename: string) {
    // Same rationale as LlamaEngine.load: ChatScreen re-mounts (and calls
    // load() again) every time Settings is closed, even if the user didn't
    // touch the model — skip re-initializing the native context if it's
    // already loaded with this exact file.
    if (this.context && this.modelFilename === modelFilename) {
      return;
    }

    const modelPath = `${FileSystem.documentDirectory}${modelFilename}`;
    const info = await FileSystem.getInfoAsync(modelPath);
    if (!info.exists) {
      throw new Error(`Embedding model not found at ${modelPath}`);
    }
    await this.unloadNow();
    // iPhone 13: llama.rn's Metal backend can fail to start; the embedder then runs on CPU (see initFallback).
    const loaded = await initWithCpuFallback(
      initLlama,
      { model: modelPath, embedding: true, n_ctx: 512, n_threads: 2 },
      { platform: Platform.OS, cpuDevices: () => cpuDeviceNames(getBackendDevicesInfo), log: (m) => console.warn(m) }
    );
    this.context = loaded.context;
    this.modelFilename = modelFilename;
  }

  embed(text: string): Promise<Float32Array> {
    return this.enqueue(async () => {
      if (!this.context) throw new Error("EmbeddingEngine: model not loaded");
      const result = await this.context.embedding(text);
      return Float32Array.from(result.embedding);
    });
  }

  unload(): Promise<void> {
    return this.enqueue(() => this.unloadNow());
  }

  private async unloadNow() {
    await this.context?.release();
    this.context = null;
    this.modelFilename = null;
  }
}

export const embeddingEngine = new EmbeddingEngine();

export { cosineSimilarity } from "./pure";
