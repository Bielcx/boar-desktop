import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * Where the phone is, from its own GPS, with no network and no Google Play
 * Services (so it works on GrapheneOS and in the offline build). No reverse
 * geocoding either: that needs a server. The place name comes from the
 * offline knowledge pack. Foreground only ("when in use"); nothing runs in
 * the background, and the position is never stored or sent anywhere.
 *
 * Android: LocationManager GPS_PROVIDER (modules/offline-location/android).
 * iOS: CoreLocation (modules/offline-location/ios).
 */

export type LocationPermissionStatus = "granted" | "denied" | "undetermined";

export interface DevicePosition {
  latitude: number;
  longitude: number;
  /** Radius of 68% confidence, in metres. */
  accuracyM: number;
  /** Fix time, ms since epoch. */
  timestamp: number;
  /** "gps" = fresh fix for this call; "cached" = the phone's last known fix. */
  source: "gps" | "cached";
}

export interface PositionOptions {
  /** Give up on a fresh fix after this long (default 15s). */
  timeoutMs?: number;
  /** Accept a last known fix this recent instead of waiting (default 10 min). */
  maxAgeMs?: number;
}

/** Rejection codes (error.code). */
export type LocationErrorCode = "E_PERMISSION" | "E_TIMEOUT" | "E_UNAVAILABLE";

interface OfflineLocationNativeModule {
  getPermissionStatus(): Promise<LocationPermissionStatus>;
  requestPermission(): Promise<"granted" | "denied">;
  getCurrentPosition(timeoutMs: number, maxAgeMs: number): Promise<DevicePosition>;
  getLastKnownPosition(): Promise<DevicePosition | null>;
}

const native = requireOptionalNativeModule<OfflineLocationNativeModule>("OfflineLocation");

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_AGE_MS = 10 * 60_000;

export function isOfflineLocationSupported(): boolean {
  return native != null;
}

export async function getPermissionStatus(): Promise<LocationPermissionStatus> {
  return native ? native.getPermissionStatus() : "denied";
}

/** Shows the system dialog. Call only after BOAR's own explanation (src/location/locationPolicy.ts). */
export async function requestPermission(): Promise<"granted" | "denied"> {
  return native ? native.requestPermission() : "denied";
}

export async function getCurrentPosition(opts: PositionOptions = {}): Promise<DevicePosition> {
  if (!native) {
    throw Object.assign(new Error("Location is not available in this build"), { code: "E_UNAVAILABLE" });
  }
  return native.getCurrentPosition(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
}

/** The phone's last fix, without turning the GPS on. null if none or no permission. */
export async function getLastKnownPosition(): Promise<DevicePosition | null> {
  return native ? native.getLastKnownPosition() : null;
}
