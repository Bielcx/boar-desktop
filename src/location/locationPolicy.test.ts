import { describe, it, expect, vi } from "vitest";
import { distanceMeters, requestLocationForQuestion, LocationSource } from "./locationPolicy";

const pos = { latitude: -23.55, longitude: -46.63, accuracyM: 20, timestamp: 1, source: "gps" as const };

function source(status: "granted" | "denied" | "undetermined", over: Partial<LocationSource> = {}) {
  const base = {
    getPermissionStatus: vi.fn(async () => status),
    requestPermission: vi.fn(async (): Promise<"granted" | "denied"> => "granted"),
    getCurrentPosition: vi.fn(async () => pos),
  };
  return Object.assign(base, over) as typeof base;
}

describe("requestLocationForQuestion", () => {
  it("explains first, then opens the system dialog, only when undetermined", async () => {
    const s = source("undetermined");
    const explain = vi.fn(async () => true);
    expect(await requestLocationForQuestion(s, explain)).toEqual({ status: "ok", position: pos });
    expect(explain).toHaveBeenCalledTimes(1);
    expect(s.requestPermission).toHaveBeenCalledTimes(1);
    expect(explain.mock.invocationCallOrder[0]).toBeLessThan(s.requestPermission.mock.invocationCallOrder[0]);
  });

  it("never opens the system dialog if the user declines the explanation", async () => {
    const s = source("undetermined");
    expect(await requestLocationForQuestion(s, async () => false)).toEqual({ status: "declined" });
    expect(s.requestPermission).not.toHaveBeenCalled();
    expect(s.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("doesn't ask again once granted or denied", async () => {
    for (const status of ["granted", "denied"] as const) {
      const s = source(status);
      const explain = vi.fn(async () => true);
      await requestLocationForQuestion(s, explain);
      expect(explain).not.toHaveBeenCalled();
      expect(s.requestPermission).not.toHaveBeenCalled();
    }
    expect(await requestLocationForQuestion(source("denied"), async () => true)).toEqual({ status: "declined" });
  });

  it("reports a missing fix as unavailable, with the native code", async () => {
    const s = source("granted", {
      getCurrentPosition: vi.fn(async () => {
        throw Object.assign(new Error("no fix"), { code: "E_TIMEOUT" });
      }),
    });
    expect(await requestLocationForQuestion(s, async () => true)).toEqual({ status: "unavailable", code: "E_TIMEOUT" });
  });

  it("passes timeout/max-age options through", async () => {
    const s = source("granted");
    await requestLocationForQuestion(s, async () => true, { timeoutMs: 5000, maxAgeMs: 0 });
    expect(s.getCurrentPosition).toHaveBeenCalledWith({ timeoutMs: 5000, maxAgeMs: 0 });
  });
});

describe("distanceMeters", () => {
  it("is 0 for the same point and ~111.2 km per degree of latitude", () => {
    expect(distanceMeters(pos, pos)).toBe(0);
    const d = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it("matches a known city pair (São Paulo–Rio ≈ 360 km)", () => {
    const d = distanceMeters({ latitude: -23.5505, longitude: -46.6333 }, { latitude: -22.9068, longitude: -43.1729 });
    expect(d / 1000).toBeGreaterThan(355);
    expect(d / 1000).toBeLessThan(365);
  });
});
