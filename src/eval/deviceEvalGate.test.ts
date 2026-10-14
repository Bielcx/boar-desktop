import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceEvalEnabled, parseDeviceEvalFlag } from "./deviceEvalGate";

describe("device evaluation gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("only EXPO_PUBLIC_DEVICE_EVAL=1 turns the flag on", () => {
    expect(parseDeviceEvalFlag("1")).toBe(true);
    expect(parseDeviceEvalFlag(" 1 ")).toBe(true);
    for (const raw of [undefined, "", "0", "true", "yes"]) expect(parseDeviceEvalFlag(raw)).toBe(false);
  });

  it("is on in development builds or with the flag, off in a shipped build", () => {
    expect(deviceEvalEnabled(true, false)).toBe(true);
    expect(deviceEvalEnabled(false, true)).toBe(true);
    expect(deviceEvalEnabled(false, false)).toBe(false);
  });

  it("reads the build flag once at module load", async () => {
    vi.stubGlobal("__DEV__", false);
    vi.stubEnv("EXPO_PUBLIC_DEVICE_EVAL", "1");
    expect((await import("./deviceEvalGate")).DEVICE_EVAL_ON).toBe(true);
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_DEVICE_EVAL", "");
    expect((await import("./deviceEvalGate")).DEVICE_EVAL_ON).toBe(false);
    vi.resetModules();
    vi.stubGlobal("__DEV__", true);
    expect((await import("./deviceEvalGate")).DEVICE_EVAL_ON).toBe(true);
  });
});
