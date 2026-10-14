import type { DevicePosition, LocationPermissionStatus, PositionOptions } from "offline-location";

/**
 * When BOAR may ask for the phone's location: only when a question needs it
 * ("near me", "in the city I'm in"), and the first time only after BOAR's own
 * explanation (i18n `location.rationale*`: the position is read from the GPS
 * and never leaves the phone). If the user said no, BOAR doesn't nag: it
 * answers without location and the user can name a place instead.
 */

export interface LocationSource {
  getPermissionStatus(): Promise<LocationPermissionStatus>;
  requestPermission(): Promise<"granted" | "denied">;
  getCurrentPosition(opts?: PositionOptions): Promise<DevicePosition>;
}

export type LocationOutcome =
  | { status: "ok"; position: DevicePosition }
  /** The user declined BOAR's explanation or the system dialog, now or earlier. */
  | { status: "declined" }
  /** Permission granted but no fix: GPS off, no signal in time, approximate-only with no last fix. */
  | { status: "unavailable"; code: string };

/**
 * @param explain Shows BOAR's explanation and resolves true if the user wants
 *   to continue to the system dialog. Called only while the permission is
 *   still undetermined, i.e. the first geographic question.
 */
export async function requestLocationForQuestion(
  source: LocationSource,
  explain: () => Promise<boolean>,
  opts?: PositionOptions
): Promise<LocationOutcome> {
  let status = await source.getPermissionStatus();
  if (status === "undetermined") {
    if (!(await explain())) return { status: "declined" };
    status = await source.requestPermission();
  }
  if (status !== "granted") return { status: "declined" };
  try {
    return { status: "ok", position: await source.getCurrentPosition(opts) };
  } catch (e: any) {
    if (e?.code === "E_PERMISSION") return { status: "declined" };
    return { status: "unavailable", code: e?.code ?? "E_UNAVAILABLE" };
  }
}

/** Great-circle distance in metres (haversine), for "450 m away" in answers. */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
