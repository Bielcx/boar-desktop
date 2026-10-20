import { describe, expect, it } from "vitest";
import { internetFromCount, internetReachable } from "../src/main/handlers/expo-network";

describe("expo-network: Windows' own internet check", () => {
  it("reads PowerShell's count of profiles with internet", () => {
    expect(internetFromCount("1\r\n")).toBe(true);
    expect(internetFromCount("0")).toBe(false);
    // Anything else: no answer, the shim falls back to navigator.onLine.
    expect(internetFromCount("")).toBeNull();
    expect(internetFromCount("Get-NetConnectionProfile : not recognized")).toBeNull();
  });

  it.runIf(process.platform === "win32")("answers on this machine", async () => {
    expect(typeof (await internetReachable())).toBe("boolean");
  }, 15_000);
});
