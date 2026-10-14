import { describe, expect, it } from "vitest";
import { isFresh, LOCATION_MAX_AGE_MS, permissionBlock, resolveFix, toError, toPoint, withoutStale } from "./location.pure";

describe("toPoint", () => {
  it("renames the fields and computes the fix age in seconds", () => {
    const pos = { latitude: -23.55, longitude: -46.63, accuracyM: 25, timestamp: 1_000_000, source: "cached" as const };
    expect(toPoint(pos, 1_090_400)).toEqual({ lat: -23.55, lon: -46.63, accuracyM: 25, ageS: 90 });
  });

  it("never reports a negative age for a clock skew", () => {
    const pos = { latitude: 0, longitude: 0, accuracyM: 5, timestamp: 2000, source: "gps" as const };
    expect(toPoint(pos, 1000)).toMatchObject({ ageS: 0 });
  });
});

describe("toError", () => {
  it("maps the module codes and treats anything else as unavailable", () => {
    expect(toError({ code: "E_PERMISSION" })).toEqual({ error: "denied" });
    expect(toError({ code: "E_TIMEOUT" })).toEqual({ error: "timeout" });
    expect(toError({ code: "E_UNAVAILABLE" })).toEqual({ error: "unavailable" });
    expect(toError(new Error("boom"))).toEqual({ error: "unavailable" });
    expect(toError(null)).toEqual({ error: "unavailable" });
  });
});

describe("isFresh", () => {
  const pos = { latitude: 0, longitude: 0, accuracyM: 5, timestamp: 1000, source: "cached" as const };
  it("accepts a fix within the age limit and rejects older or missing ones", () => {
    expect(isFresh(pos, 1000 + 60_000, 60_000)).toBe(true);
    expect(isFresh(pos, 1000 + 60_001, 60_000)).toBe(false);
    expect(isFresh(null, 0, 60_000)).toBe(false);
  });
});

describe("permissionBlock", () => {
  it("lets a granted permission through and never prompts by itself", () => {
    expect(permissionBlock("granted")).toBeNull();
    expect(permissionBlock("undetermined")).toEqual({ error: "prompt" });
    expect(permissionBlock("denied")).toEqual({ error: "denied" });
  });
});

describe("resolveFix (near me never uses an old fix by itself)", () => {
  const now = 1_000_000_000;
  const at = (minAgo: number, lat = 52.52) => ({ latitude: lat, longitude: 13.4, accuracyM: 10, timestamp: now - minAgo * 60_000, source: "gps" as const });

  it("uses a new fix", () => {
    expect(resolveFix({ last: at(23), fresh: at(0, 25.5), nowMs: now })).toMatchObject({ lat: 25.5, ageS: 0 });
  });

  it("uses a last known fix of at most 5 minutes", () => {
    expect(resolveFix({ last: at(4), fresh: null, error: { error: "timeout" }, nowMs: now })).toMatchObject({ lat: 52.52, ageS: 240 });
  });

  it("Berlin 23 min ago and no new fix in time: stale, with its age, never a position", () => {
    const r = resolveFix({ last: at(23), fresh: null, error: { error: "timeout" }, nowMs: now });
    expect(r).toEqual({ error: "stale", last: { lat: 52.52, lon: 13.4, accuracyM: 10, ageS: 23 * 60 } });
  });

  it("a cached answer from the native request is stale too", () => {
    expect(resolveFix({ last: null, fresh: at(23), nowMs: now })).toMatchObject({ error: "stale" });
  });

  it("offers the newest old fix", () => {
    const r = resolveFix({ last: at(40, 1), fresh: at(12, 2), nowMs: now });
    expect(r).toMatchObject({ error: "stale", last: { lat: 2 } });
  });

  it("no fix at all keeps the request's error; a refusal wins over an old fix", () => {
    expect(resolveFix({ last: null, fresh: null, error: { error: "timeout" }, nowMs: now })).toEqual({ error: "timeout" });
    expect(resolveFix({ last: null, fresh: null, nowMs: now })).toEqual({ error: "unavailable" });
    expect(resolveFix({ last: at(23), fresh: null, error: { error: "denied" }, nowMs: now })).toEqual({ error: "denied" });
  });

  it("the limit is 5 minutes", () => {
    expect(LOCATION_MAX_AGE_MS).toBe(5 * 60_000);
    expect(resolveFix({ last: at(5.1), fresh: null, nowMs: now })).toMatchObject({ error: "stale" });
  });
});

describe("withoutStale (the engine's current contract)", () => {
  it("turns a stale fix into 'timeout', so the old place is never listed", () => {
    expect(withoutStale({ error: "stale", last: { lat: 1, lon: 2, accuracyM: 3, ageS: 1380 } })).toEqual({ error: "timeout" });
    expect(withoutStale({ lat: 1, lon: 2, accuracyM: 3, ageS: 0 })).toEqual({ lat: 1, lon: 2, accuracyM: 3, ageS: 0 });
  });
});
