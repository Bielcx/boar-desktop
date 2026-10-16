import { describe, expect, it } from "vitest";
import { addableFile, formatParams, MAX_FILE_BYTES, searchUrl, uncensored } from "./modelBrowser";

describe("Hugging Face model search", () => {
  it("asks for text-generation GGUF repos in the size bucket, sorted, with their GGUF facts", () => {
    const url = searchUrl("qwen 3", "1to3b", "downloads");
    expect(url).toContain("search=qwen%203&");
    expect(url).toContain("filter=gguf&pipeline_tag=text-generation&num_parameters=min:1B,max:3B");
    expect(url).toContain("sort=downloads&direction=-1");
    expect(url).toContain("expand[]=gguf");
    expect(searchUrl("  ", "any", "trending")).not.toContain("search=");
  });

  it("offers only whole model files under the size cap", () => {
    expect(addableFile("Qwen3-4B-Q4_K_M.gguf", 2.5e9)).toBe(true);
    expect(addableFile("big-Q4_K_M-00001-of-00003.gguf", 5e9)).toBe(false);
    expect(addableFile("mmproj-model-f16.gguf", 6e8)).toBe(false);
    expect(addableFile("model.safetensors", 1e9)).toBe(false);
    expect(addableFile("huge-Q8_0.gguf", MAX_FILE_BYTES + 1)).toBe(false);
    expect(addableFile("empty.gguf", 0)).toBe(false);
  });

  it("formats parameter counts", () => {
    expect(formatParams(2.7e9)).toBe("2.7B");
    expect(formatParams(4e9)).toBe("4B");
    expect(formatParams(5e8)).toBe("500M");
  });
});

describe("uncensored", () => {
  it("recognizes uncensored and adult models by tag or whole word", () => {
    expect(uncensored("Orenguteng/Llama-3-8B-Lexi-Uncensored-GGUF")).toBe(true);
    expect(uncensored("mlabonne/gemma-3-4b-it-abliterated-GGUF")).toBe(true);
    expect(uncensored("someone/plain-name-GGUF", ["text-generation", "not-for-all-audiences"])).toBe(true);
    expect(uncensored("someone/model-GGUF", ["nsfw"])).toBe(true);
    expect(uncensored("someone/Adult-Chat-7B-GGUF")).toBe(true);
    expect(uncensored("Qwen/Qwen3-4B-Instruct-2507-GGUF", ["text-generation", "gguf"])).toBe(false);
    // Whole words only: "therapy" and "superpower" aren't "erp".
    expect(uncensored("someone/therapy-superpower-GGUF")).toBe(false);
  });
});
