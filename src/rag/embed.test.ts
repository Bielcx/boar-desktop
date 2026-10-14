import { describe, it, expect, vi } from "vitest";

let busy = false;
const state = vi.hoisted(() => ({ OS: "android", failGpu: false, inits: [] as any[] }));

vi.mock("react-native", () => ({ Platform: { get OS() { return state.OS; } } }));

vi.mock("llama.rn", () => ({
  getBackendDevicesInfo: async () => [
    { backend: "Metal", type: "gpu", deviceName: "MTL0" },
    { backend: "CPU", type: "cpu", deviceName: "CPU" },
  ],
  initLlama: async (params: any) => {
    state.inits.push(params);
    if (state.failGpu && params.n_gpu_layers !== 0) throw new Error("Failed to load model");
    return {
    // Like llama.rn: a second call while one is running is rejected.
    embedding: async (text: string) => {
      if (busy) throw new Error("Context is busy");
      busy = true;
      await new Promise((r) => setTimeout(r, 5));
      busy = false;
      return { embedding: [text.length] };
    },
    release: async () => {},
    };
  },
}));

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: async () => ({ exists: true }),
}));

import { EmbeddingEngine } from "./embed";

describe("EmbeddingEngine", () => {
  it("runs overlapping embed calls one at a time", async () => {
    const engine = new EmbeddingEngine();
    await engine.load("models/embedding.gguf");
    const results = await Promise.all(["a", "bb", "ccc"].map((t) => engine.embed(t)));
    expect(results.map((r) => r[0])).toEqual([1, 2, 3]);
  });

  it("waits for a load that's still in progress before embedding", async () => {
    const engine = new EmbeddingEngine();
    const load = engine.load("models/embedding.gguf");
    const embedded = engine.embed("abcd");
    await load;
    expect((await embedded)[0]).toBe(4);
  });

  it("falls back to CPU once when the Metal backend fails to start on iOS", async () => {
    Object.assign(state, { OS: "ios", failGpu: true, inits: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new EmbeddingEngine();
    await engine.load("models/embedding.gguf");
    expect((await engine.embed("abc"))[0]).toBe(3);
    expect(state.inits).toHaveLength(2);
    expect(state.inits[0]).toMatchObject({ embedding: true, flash_attn_type: "off" });
    expect(state.inits[1]).toMatchObject({ n_gpu_layers: 0, devices: ["CPU"], flash_attn_type: "off" });
    warn.mockRestore();
    Object.assign(state, { OS: "android", failGpu: false });
  });
});
