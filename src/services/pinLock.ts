/**
 * The PIN that opens BOAR and seals its chats (the native app's PinLock, same scheme), desktop only: a native
 * "PinLock" module (desktop/src/main/handlers/pin-lock.ts) keeps the data key sealed with the PIN and the Windows
 * account; this side seals and opens the chat text with it (chatHistory.ts setChatCipher). Android's Expo app has no
 * such module: pinLockAvailable() is false and no PIN is offered.
 */
import { requireOptionalNativeModule } from "expo-modules-core";
import { aesTextCipher, lockedCipher, plainCipher, type TextCipher } from "../security/textCipher";
import { clearAllHistory, resealAllChats, setChatCipher } from "./chatHistory";

export type PinAttempt = { ok: true } | { ok: false; waitSeconds: number };

interface PinLockModule {
  status(): Promise<{ isSet: boolean; waitSeconds: number; available: boolean }>;
  enable(pin: string): Promise<string>;
  unlock(pin: string): Promise<{ ok: true; key: string } | { ok: false; waitSeconds: number }>;
  change(oldPin: string, newPin: string): Promise<boolean>;
  clear(): Promise<void>;
}

const mod = requireOptionalNativeModule<PinLockModule>("PinLock");

export const pinLockAvailable = (): boolean => mod !== null;

/** 4 to 8 digits. */
export const validPin = (pin: string): boolean => /^\d{4,8}$/.test(pin);

const keyCipher = (key: string): Promise<TextCipher> => aesTextCipher(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));

export async function pinStatus(): Promise<{ isSet: boolean; waitSeconds: number; available: boolean }> {
  return mod ? mod.status() : { isSet: false, waitSeconds: 0, available: false };
}

/** At start: with a PIN set, chats stay sealed (and can't be written) until it's entered. True when locked. */
export async function lockIfSet(): Promise<boolean> {
  const { isSet } = await pinStatus();
  if (isSet) setChatCipher(lockedCipher);
  return isSet;
}

/** Locks again (after a while away): the key is dropped and the lock screen asks for the PIN. */
export function lockNow(): void {
  setChatCipher(lockedCipher);
}

export async function unlock(pin: string): Promise<PinAttempt> {
  const a = await mod!.unlock(pin);
  if (!a.ok) return a;
  setChatCipher(await keyCipher(a.key));
  return { ok: true };
}

/** Turns the PIN on: every stored chat is sealed with the new key. If that fails, the PIN is taken off again. */
export async function enablePin(pin: string): Promise<void> {
  const cipher = await keyCipher(await mod!.enable(pin));
  try {
    await resealAllChats(plainCipher, cipher);
  } catch (e) {
    await mod!.clear(); // the re-seal is one transaction: the chats are still plain
    throw e;
  }
  setChatCipher(cipher);
}

/** False when the current PIN is wrong (and the wrong try counts). */
export const changePin = (oldPin: string, newPin: string): Promise<boolean> => mod!.change(oldPin, newPin);

/** Turns the PIN off: the chats go back to plain text. */
export async function disablePin(pin: string): Promise<PinAttempt> {
  const a = await mod!.unlock(pin);
  if (!a.ok) return a;
  await resealAllChats(await keyCipher(a.key), plainCipher);
  setChatCipher(plainCipher);
  await mod!.clear();
  return { ok: true };
}

/** Forgot the PIN: the chats can't be opened any more, so they're erased with the key. */
export async function forgetPin(): Promise<void> {
  setChatCipher(plainCipher);
  await clearAllHistory();
  await mod!.clear();
}
