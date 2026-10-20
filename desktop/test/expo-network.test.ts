import { describe, expect, it } from "vitest";
import { internetFromCount, internetFromNmcli } from "../src/main/handlers/expo-network";

describe("expo-network: Windows' own internet check", () => {
  it("reads PowerShell's count of profiles with internet", () => {
    expect(internetFromCount("1\r\n")).toBe(true);
    expect(internetFromCount("0")).toBe(false);
    // Anything else: no answer, the shim falls back to navigator.onLine.
    expect(internetFromCount("")).toBeNull();
    expect(internetFromCount("Get-NetConnectionProfile : not recognized")).toBeNull();
  });

  it("reads NetworkManager's connectivity on Linux", () => {
    expect(internetFromNmcli("full\n")).toBe(true);
    for (const s of ["none", "limited", "portal"]) expect(internetFromNmcli(s)).toBe(false);
    expect(internetFromNmcli("unknown")).toBeNull();
  });
});
