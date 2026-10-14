// The "PinLock" native module on desktop (src/services/pinLock.ts finds it through the expo-modules-core shim; Android's
// Expo app has none, so no PIN is offered there): the PIN's vault, kept by main (handlers/pin-lock.ts).
import { native } from "../shared/bridge";

export type PinAttempt = { ok: true; key: string } | { ok: false; waitSeconds: number };

export const PinLock = {
  status: () => native().invoke<{ isSet: boolean; waitSeconds: number; available: boolean }>("pin-lock:status"),
  /** The new data key (base64); the PIN is saved before anything is sealed with it. */
  enable: (pin: string) => native().invoke<string>("pin-lock:enable", pin),
  unlock: (pin: string) => native().invoke<PinAttempt>("pin-lock:unlock", pin),
  change: (oldPin: string, newPin: string) => native().invoke<boolean>("pin-lock:change", oldPin, newPin),
  clear: () => native().invoke<void>("pin-lock:clear"),
};
