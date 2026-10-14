import { describe, it, expect } from "vitest";
import { allAssets } from "../models/assetRegistry";
import { PREPAREDNESS_PACK, PREPAREDNESS_SOURCES, preparednessEntry } from "./preparedness";

describe("preparedness pack", () => {
  it("is a registered sqlite pack with a measured size and hash", () => {
    expect(preparednessEntry()).toMatchObject({ id: "boar-preparedness", kind: "corpus", format: "sqlite-pack", filename: "corpus/boar-preparedness.sqlite" });
    expect(preparednessEntry().sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(allAssets().map((a) => a.id)).toContain("boar-preparedness");
  });
  it("lists sources that add up to the document count", () => {
    expect(PREPAREDNESS_SOURCES.reduce((n, s) => n + s.documents, 0)).toBe(PREPAREDNESS_PACK.docCount);
  });
});
