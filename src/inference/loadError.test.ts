import { describe, it, expect } from "vitest";
import { classifyLoadFailure, ModelLoadError } from "./loadError";

describe("classifyLoadFailure", () => {
  it("a model that fits and fails with llama.rn's terse message is the engine (iPhone Metal), not memory", () => {
    expect(classifyLoadFailure("Failed to load model", "resident")).toBe("engine");
    expect(classifyLoadFailure("Failed to load model", null)).toBe("engine");
  });
  it("memory from the native message or a fit that doesn't hold", () => {
    expect(classifyLoadFailure("ggml: failed to allocate buffer of size 812 MB", "resident")).toBe("memory");
    expect(classifyLoadFailure("Failed to load model", "thrashing")).toBe("memory");
  });
  it("a broken file is corrupt", () => {
    expect(classifyLoadFailure("gguf_init_from_file: invalid magic characters", "resident")).toBe("corrupt");
  });
  it("carries code, kind, the native message and the hint separately", () => {
    const e = new ModelLoadError('Failed to load "m.gguf": Failed to load model', "engine", "Failed to load model", "(~16GB RAM)");
    expect(e).toBeInstanceOf(Error);
    expect({ code: e.code, kind: e.kind, native: e.native, hint: e.hint }).toEqual({ code: "load_failed", kind: "engine", native: "Failed to load model", hint: "(~16GB RAM)" });
    expect(e.message).not.toContain("RAM");
  });
});
