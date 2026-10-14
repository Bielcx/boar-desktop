import { describe, it, expect } from "vitest";
import { voicePolicy, RecognitionMode } from "./voicePolicy";
import { voiceInBuild } from "../config/variant";

const base = { variant: "downloader" as const, voiceInBuild: true, systemServiceAccepted: false };

describe("voicePolicy", () => {
  it("uses on-device recognition whenever the phone has it, in both builds", () => {
    for (const variant of ["downloader", "offline"] as const) {
      expect(voicePolicy({ ...base, variant, mode: "on-device" })).toEqual({
        usable: true,
        requireOnDevice: true,
        reason: "on-device",
      });
    }
  });

  it("never falls back to the system service without explicit consent", () => {
    expect(voicePolicy({ ...base, mode: "system" })).toMatchObject({ usable: false, reason: "system-needs-consent" });
    expect(voicePolicy({ ...base, mode: "system", systemServiceAccepted: true })).toEqual({
      usable: true,
      requireOnDevice: false,
      reason: "system-accepted",
    });
  });

  it("never uses the system service in the offline build, even with consent", () => {
    expect(voicePolicy({ ...base, variant: "offline", mode: "system", systemServiceAccepted: true })).toMatchObject({
      usable: false,
      requireOnDevice: true,
      reason: "system-blocked-offline",
    });
  });

  it("is unusable when the build has no microphone permission or the phone has no recognizer", () => {
    for (const mode of ["on-device", "system", "unavailable"] as RecognitionMode[]) {
      expect(voicePolicy({ ...base, mode, voiceInBuild: false }).usable).toBe(false);
    }
    expect(voicePolicy({ ...base, mode: "unavailable" }).reason).toBe("unavailable");
  });
});

describe("voiceInBuild", () => {
  it("matches the permissions the build plugin keeps", () => {
    expect(voiceInBuild("downloader", undefined)).toBe(true);
    expect(voiceInBuild("offline", undefined)).toBe(false);
    expect(voiceInBuild("offline", "1")).toBe(true);
  });
});
