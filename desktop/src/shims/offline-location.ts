// Desktop shim for "offline-location": no GPS on desktop. Reports unsupported, so
// src/services/deviceLocation.ts returns null and the app runs without location.
export type { DevicePosition, LocationErrorCode, LocationPermissionStatus, PositionOptions } from "../../../modules/offline-location";
import type { DevicePosition, LocationPermissionStatus } from "../../../modules/offline-location";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_AGE_MS = 10 * 60_000;
export const isOfflineLocationSupported = (): boolean => false;
export const getPermissionStatus = async (): Promise<LocationPermissionStatus> => "denied";
export const requestPermission = async (): Promise<"granted" | "denied"> => "denied";
export const getLastKnownPosition = async (): Promise<DevicePosition | null> => null;
export async function getCurrentPosition(): Promise<DevicePosition> {
  throw Object.assign(new Error("Location is not available on desktop"), { code: "E_UNAVAILABLE" });
}
