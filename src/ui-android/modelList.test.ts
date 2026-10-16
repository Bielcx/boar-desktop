import { describe, it, expect } from "vitest";
import type { CatalogModel } from "../models/manifest";
import { listedModels } from "./modelList";

const m = (id: string, extra: Partial<CatalogModel> = {}) => ({ id, kind: "llm", filename: `models/${id}.gguf`, ...extra }) as CatalogModel;
const catalog = [m("phi", { hidden: true }), m("qwen3"), m("qwen2.5"), m("bge", { kind: "embedding" }), m("pack", { kind: "corpus" as CatalogModel["kind"] })];

describe("listedModels", () => {
  it("puts the active model on top, then ready ones, then the rest, in catalog order", () => {
    const ids = listedModels(catalog, [m("hf-a")], { "qwen2.5": true, bge: true, "hf-a": true }, { llm: "qwen2.5" }).map((x) => x.id);
    expect(ids).toEqual(["qwen2.5", "bge", "hf-a", "qwen3"]);
  });

  it("lists a hidden model only where it's installed, and a discovered copy of a catalog file once", () => {
    expect(listedModels(catalog, [], {}, {}).map((x) => x.id)).toEqual(["qwen3", "qwen2.5", "bge"]);
    expect(listedModels(catalog, [], { phi: true }, {}).map((x) => x.id)).toEqual(["phi", "qwen3", "qwen2.5", "bge"]);
    expect(listedModels(catalog, [{ ...m("hf-qwen3"), filename: "models/qwen3.gguf" }], {}, {}).map((x) => x.id)).not.toContain("hf-qwen3");
  });
});
