import { describe, it, expect } from "vitest";
import { parseVariant } from "./variant";

describe("parseVariant", () => {
  it("is offline only when explicitly asked for", () => {
    expect(parseVariant("offline")).toBe("offline");
    expect(parseVariant(" OFFLINE ")).toBe("offline");
    expect(parseVariant(undefined)).toBe("downloader");
    expect(parseVariant("")).toBe("downloader");
    expect(parseVariant("anything")).toBe("downloader");
  });
});
