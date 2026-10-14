// A hardware-backed key that signs shared evaluation runs (see the native modules and
// supabase/functions/submit-results). Android: a Keystore key with Google-signed attestation.
// iOS: an App Attest key. Absent on other platforms and in builds without the module.
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

export interface CreatedKey {
  /** Android: the attestation chain, leaf first. iOS: Apple's attestation object. Base64. */
  attestation: string[];
  /** Android: the key's SubjectPublicKeyInfo (base64). */
  publicKey?: string;
  /** iOS: the App Attest key id (base64). */
  keyId?: string;
}

interface DeviceKeyNativeModule {
  isSupported?(): boolean;
  hasKey(): boolean;
  createKey(challenge: string): Promise<CreatedKey>;
  createUnattestedKey?(): Promise<CreatedKey>;
  sign(data: string): Promise<string>;
  deleteKey(): void;
}

const native = requireOptionalNativeModule<DeviceKeyNativeModule>("DeviceKey");

/** Whether this phone can make a key the server will accept. */
export function deviceKeySupported(): boolean {
  if (!native) return false;
  if (Platform.OS === "ios") return native.isSupported?.() ?? false;
  return Platform.OS === "android";
}

export const hasDeviceKey = (): boolean => native?.hasKey() ?? false;

export function createDeviceKey(challenge: string): Promise<CreatedKey> {
  if (!native) return Promise.reject(new Error("device-key module missing"));
  return native.createKey(challenge);
}

/**
 * Android only: a key without attestation, for a phone whose secure hardware refused to attest
 * (createDeviceKey rejected with code ERR_DEVICE_KEY_ATTESTATION). Runs signed with it are stored
 * for review instead of going straight to the public scores.
 */
export function createUnattestedDeviceKey(): Promise<CreatedKey> {
  if (!native?.createUnattestedKey) return Promise.reject(new Error("unattested keys aren't available here"));
  return native.createUnattestedKey();
}

/** Android: DER ECDSA signature. iOS: App Attest assertion. Base64 either way. */
export function signWithDeviceKey(data: string): Promise<string> {
  if (!native) return Promise.reject(new Error("device-key module missing"));
  return native.sign(data);
}

export const deleteDeviceKey = (): void => native?.deleteKey();
