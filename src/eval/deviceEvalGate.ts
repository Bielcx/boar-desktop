/**
 * Whether this JS bundle answers device evaluation requests (a request file
 * written into the app's private storage by scripts/eval-iphone.mjs over
 * devicectl, or over adb run-as on Android). Development builds always do.
 * Other builds only when built with EXPO_PUBLIC_DEVICE_EVAL=1 (Expo inlines
 * EXPO_PUBLIC_* into the bundle at build time, as for EXPO_PUBLIC_BOAR_VARIANT):
 * a shipped build never polls for requests nor creates eval/requests.
 */
export function parseDeviceEvalFlag(raw: string | undefined): boolean {
  return raw?.trim() === "1";
}

export function deviceEvalEnabled(dev: boolean, flag: boolean): boolean {
  return dev || flag;
}

/** Read once at module load. `__DEV__` is React Native's global (undefined under plain Node, e.g. vitest). */
export const DEVICE_EVAL_ON: boolean = deviceEvalEnabled(
  typeof __DEV__ !== "undefined" && !!__DEV__,
  parseDeviceEvalFlag(process.env.EXPO_PUBLIC_DEVICE_EVAL)
);
