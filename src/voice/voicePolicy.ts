import type { AppVariant } from "../config/variant";

/** What the phone offers (modules/voice-input getRecognitionMode). */
export type RecognitionMode = "on-device" | "system" | "unavailable";

export type VoiceSupportReason =
  /** Audio stays on the phone (Android 12+ on-device recognizer). */
  | "on-device"
  /** User accepted that the system service may use the network. */
  | "system-accepted"
  /** Only the system service exists; the user hasn't accepted it. Ask, with the warning. */
  | "system-needs-consent"
  /** Only the system service exists, and the offline build never uses it. */
  | "system-blocked-offline"
  /** This APK was built without RECORD_AUDIO. */
  | "not-in-build"
  | "unavailable";

export interface VoiceSupport {
  usable: boolean;
  /** Passed to the native recognizer: refuse anything that isn't on-device. */
  requireOnDevice: boolean;
  reason: VoiceSupportReason;
}

/**
 * Voice input is off by default (settings). When the user turns it on, BOAR
 * uses on-device recognition only; the system recognition service (usually
 * Google's, which may send audio to its servers) needs explicit consent,
 * and is never used by the offline build.
 */
export function voicePolicy(input: {
  mode: RecognitionMode;
  variant: AppVariant;
  voiceInBuild: boolean;
  systemServiceAccepted: boolean;
}): VoiceSupport {
  if (!input.voiceInBuild) return { usable: false, requireOnDevice: true, reason: "not-in-build" };
  switch (input.mode) {
    case "on-device":
      return { usable: true, requireOnDevice: true, reason: "on-device" };
    case "system":
      if (input.variant === "offline") return { usable: false, requireOnDevice: true, reason: "system-blocked-offline" };
      return input.systemServiceAccepted
        ? { usable: true, requireOnDevice: false, reason: "system-accepted" }
        : { usable: false, requireOnDevice: true, reason: "system-needs-consent" };
    default:
      return { usable: false, requireOnDevice: true, reason: "unavailable" };
  }
}
