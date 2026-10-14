import { describe, expect, it, vi } from "vitest";

// Plain functions, not vi.fn(): the test swaps the implementation per case.
const native = vi.hoisted(() => ({
  calls: [] as string[],
  excludeImpl: (_path: string): Promise<boolean> => Promise.resolve(true),
}));

vi.mock("expo-modules-core", () => ({
  requireNativeModule: () => ({
    excludeFromBackup: (path: string) => {
      native.calls.push(path);
      return native.excludeImpl(path);
    },
  }),
}));

import { excludeFromBackup } from "./index";

describe("excludeFromBackup", () => {
  it("passes the path through and returns the native result", async () => {
    native.excludeImpl = () => Promise.resolve(true);
    await expect(excludeFromBackup("file:///docs/models/a.gguf")).resolves.toBe(true);
    expect(native.calls).toContain("file:///docs/models/a.gguf");
  });

  it("resolves false when the native call rejects", async () => {
    native.excludeImpl = () => Promise.reject(new Error("no such file"));
    await expect(excludeFromBackup("/missing")).resolves.toBe(false);
  });

  it("resolves false on a native build without the function", async () => {
    native.excludeImpl = () => {
      throw new TypeError("excludeFromBackup is not a function");
    };
    await expect(excludeFromBackup("/x")).resolves.toBe(false);
  });
});
