// Sharing an evaluation run with the BOAR project (supabase/functions/submit-results). Pure
// parts: what gets sent, and what the server's answer means. The app never sends anything on
// its own; the user presses "Share results" and confirms what is listed. The run is signed with
// the phone's hardware key (modules/device-key); see shareResults.ts.
import type { EvalResultRow } from "./evalHarness.pure";

export interface ShareDevice {
  platform: "android" | "ios";
  osVersion?: string;
  apiLevel?: number;
  brand?: string;
  model?: string;
  /** Chipset, e.g. "MT6897" (Android 12+). */
  soc?: string;
  socManufacturer?: string;
  /** Build.HARDWARE: the board name, often the chipset on older phones. */
  hardware?: string;
  ramBytes?: number;
  cpuCores?: number;
  /** CPU flags from /proc/cpuinfo, e.g. ["asimddp", "i8mm"]. */
  cpuFeatures?: string[];
  /** Each core's top frequency in kHz, in core order; 0 where unknown. */
  coreMaxFreqKHz?: number[];
}

/** The signed payload: no install id or account, the device is the attested key. */
export interface ShareSubmission {
  run: {
    runId: string;
    evalSetVersion: string;
    appVersion: string;
    platform: "android" | "ios";
    osVersion?: string;
    apiLevel?: number;
    deviceBrand?: string;
    deviceModel?: string;
    soc?: string;
    socManufacturer?: string;
    hardware?: string;
    ramBytes?: number;
    cpuCores?: number;
    cpuFeatures?: string[];
    coreMaxFreqKHz?: number[];
  };
  rows: EvalResultRow[];
}

/** Both values come from .env (EXPO_PUBLIC_*); without them the app has no share button. */
export function submitResultsUrl(supabaseUrl: string | undefined, publishableKey: string | undefined): string | null {
  if (!supabaseUrl || !publishableKey) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/submit-results`;
}

export function buildSubmission(
  rows: EvalResultRow[],
  device: ShareDevice,
  appVersion: string
): ShareSubmission {
  const first = rows[0];
  return {
    run: {
      runId: first.runId,
      evalSetVersion: first.evalSetVersion,
      appVersion,
      platform: device.platform,
      osVersion: device.osVersion,
      apiLevel: device.apiLevel,
      deviceBrand: device.brand,
      deviceModel: device.model,
      soc: device.soc || undefined,
      socManufacturer: device.socManufacturer || undefined,
      hardware: device.hardware || undefined,
      ramBytes: device.ramBytes && device.ramBytes > 0 ? device.ramBytes : undefined,
      cpuCores: device.cpuCores,
      // iOS reports no CPU flags: an empty list means unknown, not "no i8mm or dotprod".
      cpuFeatures: device.cpuFeatures && device.cpuFeatures.length > 0 ? device.cpuFeatures : undefined,
      coreMaxFreqKHz: device.coreMaxFreqKHz,
    },
    rows,
  };
}

export type ShareResult =
  | "shared"
  /** Stored, but this phone couldn't attest its key: the team reviews it before it's public. */
  | "shared-pending"
  | "already-shared"
  | "rate-limited"
  | "cooldown"
  | "network-limited"
  | "rejected"
  /** No answer from the server: no connection, or it timed out. */
  | "offline"
  /** The server is at a limit for everyone right now (busy, review queue full). */
  | "busy"
  | "server-error"
  /** This phone couldn't make or use a key to sign with. */
  | "key-failed"
  | "failed";

export interface ShareOutcome {
  result: ShareResult;
  /** When this phone may share again (rate-limited, cooldown), as the server's ISO time. */
  retryAt?: string;
  /** The HTTP status, when the server answered. */
  status?: number;
  /** What the server or the phone said, shown under "details" (English, technical). */
  detail?: string;
}

/** What submit-results answered, as something the screen can say. */
export function shareOutcome(status: number, body?: { error?: unknown; retryAt?: unknown; pendingReview?: unknown } | null): ShareOutcome {
  const detail = typeof body?.error === "string" ? body.error : undefined;
  if (status === 201) return { result: body?.pendingReview === true ? "shared-pending" : "shared", status };
  if (status === 409) return { result: "already-shared", status };
  if (status === 429) {
    // Many phones on one network (shared Wi-Fi, mobile carrier) together hit a separate cap.
    if (body?.error === "network_limited") return { result: "network-limited", status, detail };
    const retryAt = typeof body?.retryAt === "string" && !Number.isNaN(Date.parse(body.retryAt)) ? body.retryAt : undefined;
    return { result: body?.error === "cooldown" ? "cooldown" : "rate-limited", retryAt, status, detail };
  }
  if (status >= 400 && status < 500) return { result: "rejected", status, detail };
  if (status === 503) return { result: "busy", status, detail };
  if (status >= 500) return { result: "server-error", status, detail };
  return { result: "failed", status, detail };
}

/** The steps of a share, in order, as the progress screen shows them. */
export const SHARE_STEPS = ["prepare", "challenge", "key", "sign", "send"] as const;
export type ShareStep = (typeof SHARE_STEPS)[number];

/** What a step reports for the progress screen's log (no secrets: a challenge is single-use). */
export interface ShareStepInfo {
  /** challenge: its first characters. */
  challenge?: string;
  /** key: made now or reused, and whether the secure hardware vouched for it. */
  key?: "new-attested" | "new-unattested" | "existing";
  /** send: the payload's size and row count. */
  bytes?: number;
  rows?: number;
}

/**
 * The progress screen shows each step for at least this long, and the whole share for at least
 * SHARE_MIN_MS, so a fast network still shows what happened instead of a flash.
 */
export const STEP_MIN_MS = 350;
export const SHARE_MIN_MS = 1500;

/** Results a user can do something about by trying again, now or later. */
export function shareCanRetry(result: ShareResult): boolean {
  return result === "offline" || result === "busy" || result === "server-error" || result === "failed";
}

/** Results that count as shared (the run is on the server). */
export function shareSucceeded(result: ShareResult): boolean {
  return result === "shared" || result === "shared-pending" || result === "already-shared";
}

/** The string the phone's key signs: the server's one-time challenge, then the exact payload. */
export const signedMessage = (challenge: string, payload: string): string => `${challenge}.${payload}`;

/** The Features line of /proc/cpuinfo as a list of flags. */
export function parseCpuFeatures(line: string | undefined): string[] {
  return (line ?? "").split(/\s+/).filter(Boolean);
}

/** "MediaTek MT6897", falling back to the board name when Android doesn't report the chipset. */
export function describeChipset(d: ShareDevice): string | undefined {
  if (d.soc) return [d.socManufacturer, d.soc].filter(Boolean).join(" ");
  return d.hardware || undefined;
}

/** "4 × 3.35 GHz + 4 × 2.2 GHz": cores grouped by top frequency, fastest first. */
export function describeCores(coreMaxFreqKHz: number[] | undefined): string | undefined {
  const known = (coreMaxFreqKHz ?? []).filter((f) => f > 0);
  if (known.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const f of known) counts.set(f, (counts.get(f) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([f, n]) => `${n} × ${Number((f / 1e6).toFixed(2))} GHz`)
    .join(" + ");
}

/** The CPU features llama.cpp's speed depends on most: int8 matrix multiply and dot product. */
export function inferenceFeatures(features: string[] | undefined): { i8mm: boolean; dotprod: boolean } | undefined {
  if (!features || features.length === 0) return undefined;
  return { i8mm: features.includes("i8mm"), dotprod: features.includes("asimddp") };
}

/**
 * Who made the phone and what it is, plus its cores, for a shared run. iOS reports no brand or model through
 * React Native, and no core frequencies: an iPhone is "Apple" with its model identifier (e.g. "iPhone14,5"),
 * and a list of unknown (0) frequencies is left out, so the public scores show no "0 MHz" CPU. The core count
 * still comes from that list's length.
 */
export function deviceIdentity(
  platform: "android" | "ios",
  constants: { Brand?: string; Model?: string },
  hw: { hardware?: string; coreMaxFreqKHz?: number[] } | null
): Pick<ShareDevice, "brand" | "model" | "cpuCores" | "coreMaxFreqKHz"> {
  const cores = hw?.coreMaxFreqKHz ?? [];
  const ios = platform === "ios";
  return {
    brand: ios ? "Apple" : constants.Brand,
    model: ios ? hw?.hardware || constants.Model : constants.Model,
    cpuCores: cores.length > 0 ? cores.length : undefined,
    coreMaxFreqKHz: cores.some((f) => f > 0) ? cores : undefined,
  };
}
