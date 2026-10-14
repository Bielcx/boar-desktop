// Sends one evaluation run to the BOAR project's submit-results function (supabase/). Only
// called after the user confirms on the Evaluation screen; see shareResults.pure.ts.
import { Platform } from "react-native";
import {
  createDeviceKey,
  createUnattestedDeviceKey,
  deleteDeviceKey,
  deviceKeySupported,
  hasDeviceKey,
  signWithDeviceKey,
} from "device-key";
import { getDeviceTotalRamBytes, getHardwareInfo } from "ram-monitor";
import appConfig from "../../app.json";
import { getShareDeviceId, setShareDeviceId } from "../models/settings";
import { networkAllowed } from "../config/variant";
import type { EvalResultRow } from "./evalHarness.pure";
import {
  buildSubmission,
  deviceIdentity,
  parseCpuFeatures,
  shareOutcome,
  signedMessage,
  submitResultsUrl,
  type ShareDevice,
  type ShareOutcome,
  type ShareStep,
  type ShareStepInfo,
} from "./shareResults.pure";

// Expo inlines EXPO_PUBLIC_* at build time only when they're read by their full name.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const ENDPOINT = submitResultsUrl(SUPABASE_URL, PUBLISHABLE_KEY);

/**
 * False in builds made without the Supabase values in .env, in the offline build (no network
 * permission), and on phones without a hardware key (emulators, simulators): no share button.
 */
export const resultsSharingAvailable = ENDPOINT !== null && networkAllowed() && deviceKeySupported();

/** Everything about this phone that a shared run carries (listed on the preview before sending). */
export function shareDevice(): ShareDevice {
  const c = Platform.constants as { Brand?: string; Model?: string; Release?: string; osVersion?: string };
  const hw = getHardwareInfo();
  const platform = Platform.OS === "ios" ? "ios" : "android";
  return {
    platform,
    osVersion: c.Release ?? c.osVersion ?? String(Platform.Version),
    apiLevel: hw?.apiLevel,
    ...deviceIdentity(platform, c, hw),
    soc: hw?.socModel,
    socManufacturer: hw?.socManufacturer,
    hardware: hw?.hardware,
    ramBytes: getDeviceTotalRamBytes(),
    cpuFeatures: hw ? parseCpuFeatures(hw.cpuFeatures) : undefined,
  };
}

/** A request the server never answered: no connection, or no answer within this long. */
const TIMEOUT_MS = 30_000;

class Offline extends Error {}
class KeyFailed extends Error {}

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT!, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: PUBLISHABLE_KEY! },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (e) {
    throw new Offline(abort.signal.aborted ? `no answer in ${TIMEOUT_MS / 1000} s` : String((e as Error)?.message ?? e));
  } finally {
    clearTimeout(timer);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // an empty or non-JSON answer: the status says enough
  }
  return { status: res.status, body: json };
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * A key for this share: a new attested one (the first share, or after the server forgot it), or,
 * when the secure hardware refuses to attest (ERR_DEVICE_KEY_ATTESTATION, some genuine phones), a
 * new unattested one whose runs wait for review.
 */
async function newDevice(platform: "android" | "ios", challenge: string, onStep: (s: ShareStep, i?: ShareStepInfo) => void) {
  try {
    const key = await createDeviceKey(challenge);
    onStep("key", { key: "new-attested" });
    return { platform, attestation: key.attestation, keyId: key.keyId };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (platform !== "android" || code !== "ERR_DEVICE_KEY_ATTESTATION") throw new KeyFailed(errorText(e));
    console.warn("[share] the secure hardware can't attest, sharing for review:", errorText(e));
    try {
      const key = await createUnattestedDeviceKey();
      onStep("key", { key: "new-unattested" });
      return { platform, attestation: [], publicKey: key.publicKey, attestationError: errorText(e) };
    } catch (e2) {
      throw new KeyFailed(errorText(e2));
    }
  }
}

/**
 * Sends one run, signed with this phone's hardware key: ask for a one-time challenge, sign
 * `challenge.payload`, send. The first share (or one after the server forgot the key) creates the
 * key with that challenge in its attestation, so the server can check it is a real phone running
 * BOAR. Nothing here is retried on its own except that one re-registration. `onStep` reports each
 * step as it starts, for the progress screen.
 */
export async function shareEvalRun(
  rows: EvalResultRow[],
  onStep: (step: ShareStep, info?: ShareStepInfo) => void = () => {}
): Promise<ShareOutcome> {
  if (!resultsSharingAvailable || rows.length === 0) return { result: "failed" };
  const platform = Platform.OS === "ios" ? "ios" : "android";
  onStep("prepare", { rows: rows.length });
  const payload = JSON.stringify(buildSubmission(rows, shareDevice(), appConfig.expo.version));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      onStep("challenge");
      const issued = await post({ step: "challenge" });
      const challenge = issued.body?.challenge;
      if (issued.status !== 200 || typeof challenge !== "string") return shareOutcome(issued.status, issued.body);
      onStep("challenge", { challenge: challenge.slice(0, 8) });

      const knownId = hasDeviceKey() ? await getShareDeviceId() : undefined;
      let device: Record<string, unknown>;
      if (knownId) {
        onStep("key", { key: "existing" });
        device = { platform, id: knownId };
      } else {
        onStep("key");
        device = await newDevice(platform, challenge, onStep);
      }
      onStep("sign");
      let signature: string;
      try {
        signature = await signWithDeviceKey(signedMessage(challenge, payload));
      } catch (e) {
        throw new KeyFailed(errorText(e));
      }
      onStep("send", { bytes: payload.length, rows: rows.length });
      const sent = await post({ step: "submit", challenge, payload, signature, device });
      if (typeof sent.body?.device === "string") await setShareDeviceId(sent.body.device);
      // The server doesn't know this key (e.g. its data was reset): make a new one, once.
      if (sent.status === 412 && attempt === 0) {
        await setShareDeviceId(undefined);
        deleteDeviceKey();
        continue;
      }
      return shareOutcome(sent.status, sent.body);
    }
    return { result: "failed" };
  } catch (e) {
    if (e instanceof Offline) return { result: "offline", detail: e.message };
    if (e instanceof KeyFailed) return { result: "key-failed", detail: e.message };
    return { result: "failed", detail: errorText(e) };
  }
}
