/**
 * The GPS-only native module (modules/offline-location) behind a small interface, or null in a
 * build without it. Engine-side so location.ts doesn't reach into a UI folder.
 */
import * as OfflineLocation from "offline-location";
import type { NativePosition } from "./location.pure";

export interface DeviceLocationModule {
  getPermissionStatus(): Promise<"granted" | "denied" | "undetermined">;
  requestPermission(): Promise<"granted" | "denied">;
  getLastKnownPosition?(): Promise<NativePosition | null>;
  getCurrentPosition(opts: { timeoutMs?: number; maxAgeMs?: number }): Promise<NativePosition>;
}

export function deviceLocation(): DeviceLocationModule | null {
  return OfflineLocation.isOfflineLocationSupported() ? OfflineLocation : null;
}
