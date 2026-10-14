/**
 * The phone's position for offline places, on top of Ledger's
 * modules/offline-location (GPS only, no Google Play Services). Never asks
 * for permission itself: callers check the status and ask in context.
 * The routing layer (Tusk) receives getCurrentPoint through
 * registerGeoProviders, so this file is the one place that talks to the
 * native module.
 */
import { deviceLocation } from "./deviceLocation";
import { requestLocationForQuestion } from "../location/locationPolicy";

export type { FixResult, NativePosition, PermissionStatus, Point, PointResult } from "./location.pure";
export { LOCATION_MAX_AGE_MS } from "./location.pure";
import {
  FixResult,
  isFresh,
  LOCATION_MAX_AGE_MS,
  NativePosition,
  permissionBlock,
  PermissionStatus,
  PointResult,
  resolveFix,
  toError,
  toPoint,
  withoutStale,
} from "./location.pure";

/** What the "use my location" button gets back (Ledger's requestLocationForQuestion). */
export type LocationRequest =
  | { status: "ok"; lat: number; lon: number }
  | { status: "declined" }
  | { status: "unavailable" };

export async function getLocationPermission(): Promise<PermissionStatus> {
  const native = deviceLocation();
  if (!native) return "denied";
  try {
    return await native.getPermissionStatus();
  } catch {
    return "denied";
  }
}

/** Opens the system dialog. Call it only after the user asked for location in context. */
export async function requestLocationPermission(): Promise<"granted" | "denied"> {
  const native = deviceLocation();
  if (!native) return "denied";
  try {
    return await native.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * A position for "near me": the last known fix if it is at most 5 min old,
 * else a new fix within `timeoutMs` (~3 s). If none arrives, "stale" with the
 * newest old fix and its age, so the caller can offer it instead of using it.
 */
export async function getLocationFix({ timeoutMs = 3_000, maxAgeMs = LOCATION_MAX_AGE_MS } = {}): Promise<FixResult> {
  const native = deviceLocation();
  if (!native) return { error: "unavailable" };
  const blocked = permissionBlock(await getLocationPermission());
  if (blocked) return blocked;
  const last = await native.getLastKnownPosition?.().catch(() => null);
  if (isFresh(last, Date.now(), maxAgeMs)) return toPoint(last, Date.now());
  let fresh: NativePosition | null = null;
  let error: PointResult | null = null;
  try {
    fresh = await native.getCurrentPosition({ timeoutMs, maxAgeMs });
  } catch (e) {
    error = toError(e);
  }
  return resolveFix({ last, fresh, error, nowMs: Date.now() }, maxAgeMs);
}

/** The engine's current contract (GeoProviders.getLocation): a stale fix reads as "timeout", never as the old place. */
export async function getCurrentPoint({ timeoutMs = 3_000, maxAgeMs = LOCATION_MAX_AGE_MS } = {}): Promise<PointResult> {
  return withoutStale(await getLocationFix({ timeoutMs, maxAgeMs }));
}

/**
 * For an explicit "use my location" tap: Ledger's policy shows `explain`
 * only while the permission is undetermined, then the system dialog, and
 * never asks again after a "no".
 */
export async function locateForUser(explain: () => Promise<boolean>): Promise<LocationRequest> {
  const native = deviceLocation();
  if (!native) return { status: "unavailable" };
  const outcome = await requestLocationForQuestion(native, explain);
  if (outcome.status === "ok") return { status: "ok", lat: outcome.position.latitude, lon: outcome.position.longitude };
  return { status: outcome.status };
}
