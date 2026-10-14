// Desktop shim for "device-key": no hardware-attested key on desktop. deviceKeySupported() is false, so
// src/eval/shareResults.ts turns result sharing off (resultsSharingAvailable) and never calls the rest.
import type { CreatedKey } from "../../../modules/device-key";
export type { CreatedKey };

const unsupported = () => Promise.reject(new Error("device keys aren't available on desktop"));
export const deviceKeySupported = (): boolean => false;
export const hasDeviceKey = (): boolean => false;
export const createDeviceKey = (_challenge: string): Promise<CreatedKey> => unsupported();
export const createUnattestedDeviceKey = (): Promise<CreatedKey> => unsupported();
export const signWithDeviceKey = (_data: string): Promise<string> => unsupported();
export const deleteDeviceKey = (): void => {};
