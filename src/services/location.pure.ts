/** Pure half of location.ts: result shapes and the mapping from the native module. */

export type PermissionStatus = "granted" | "denied" | "undetermined";

/** A fix older than this is never used on its own for "near me" (Boar, 27/09: Berlin listed while in Qujing). */
export const LOCATION_MAX_AGE_MS = 5 * 60_000;

export interface Point {
  lat: number;
  lon: number;
  accuracyM: number;
  ageS: number;
}

export type PointResult =
  | Point
  /** "prompt": permission not decided yet; the caller asks in context, this module never does. */
  | { error: "denied" | "unavailable" | "timeout" | "prompt" };

/** Shape returned by modules/offline-location ("offline-location") getCurrentPosition. */
export interface NativePosition {
  latitude: number;
  longitude: number;
  accuracyM: number;
  timestamp: number;
  source: "gps" | "cached";
}

export function toPoint(pos: NativePosition, nowMs: number): PointResult {
  return {
    lat: pos.latitude,
    lon: pos.longitude,
    accuracyM: pos.accuracyM,
    ageS: Math.max(0, Math.round((nowMs - pos.timestamp) / 1000)),
  };
}

/** Maps the module's rejection codes; anything unknown counts as unavailable. */
export function toError(e: unknown): PointResult {
  const code = (e as { code?: string } | null)?.code;
  if (code === "E_PERMISSION") return { error: "denied" };
  if (code === "E_TIMEOUT") return { error: "timeout" };
  return { error: "unavailable" };
}

/** A last known fix is good enough when it is no older than `maxAgeMs`. */
export function isFresh(pos: NativePosition | null | undefined, nowMs: number, maxAgeMs: number): pos is NativePosition {
  return !!pos && nowMs - pos.timestamp <= maxAgeMs;
}

/** Why a point can't be read without asking, from the permission status; null when it can. */
export function permissionBlock(status: PermissionStatus): PointResult | null {
  if (status === "granted") return null;
  return { error: status === "undetermined" ? "prompt" : "denied" };
}

/**
 * `PointResult`, plus "stale": no fix within LOCATION_MAX_AGE_MS arrived in
 * time, and `last` is the newest one the phone had. The caller must not list
 * that place by itself: it offers "Use <city>" or "Choose a city".
 */
export type FixResult = PointResult | { error: "stale"; last: Point };

/**
 * What a location request amounts to, from the last known fix and the
 * attempt at a new one (a position, or the error it failed with). A position
 * older than `maxAgeMs` counts only as "stale", whichever path returned it:
 * the native module may answer a request with a cached fix.
 */
export function resolveFix(
  s: { last: NativePosition | null | undefined; fresh: NativePosition | null | undefined; error?: PointResult | null; nowMs: number },
  maxAgeMs = LOCATION_MAX_AGE_MS
): FixResult {
  if (s.error && "error" in s.error && (s.error.error === "denied" || s.error.error === "prompt")) return s.error;
  for (const pos of [s.fresh, s.last]) if (isFresh(pos, s.nowMs, maxAgeMs)) return toPoint(pos, s.nowMs);
  const newest = [s.fresh, s.last].filter((p): p is NativePosition => !!p).sort((a, b) => b.timestamp - a.timestamp)[0];
  if (newest) return { error: "stale", last: toPoint(newest, s.nowMs) as Point };
  return s.error ?? { error: "unavailable" };
}

/** For callers that only know PointResult: a stale fix is no position ("timeout"), never an old place. */
export function withoutStale(r: FixResult): PointResult {
  return "error" in r && r.error === "stale" ? { error: "timeout" } : (r as PointResult);
}
