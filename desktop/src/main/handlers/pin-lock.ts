import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HandlerContext } from "./context";

/**
 * "PinLock" (Settings > Security): the PIN that opens BOAR and the key its chats are sealed with (the native app's
 * PinLock.kt, same scheme). A random data key seals the chat text in the page (src/security/textCipher.ts); here it is
 * stored sealed twice: with a key derived from the PIN (PBKDF2-HMAC-SHA256), then with the system account's key
 * (Electron safeStorage: DPAPI on Windows, the Keychain on macOS, the Secret Service keyring on Linux), so a copy of the files can't be opened, or brute-forced, on another computer or account.
 * The PIN itself is never stored. Wrong tries and the wait after them are counted here, out of the page's reach.
 * Stored in <userData>/pin.json, outside the folders the page can reach. Notes: docs/06-seguranca.md, item 10.
 */
export const ITERATIONS = 210_000;

/** The second seal: the system's own key store (safeStorage); tests pass their own. */
export interface DeviceSeal {
  available(): boolean;
  seal(b: Buffer): Buffer;
  open(b: Buffer): Buffer;
}

interface VaultFile {
  wrapped: string;
  salt: string;
  iterations: number;
  failures: number;
  lockedUntil: number;
}

export type Attempt = { ok: true; key: string } | { ok: false; waitSeconds: number };

/** 4 to 8 digits. */
export const validPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{4,8}$/.test(pin);

/** Seconds to wait before the next try after `failures` wrong PINs: none for the first 4, then 30 s doubling, at most 1 h. */
export const backoffSeconds = (failures: number): number => (failures < 5 ? 0 : Math.min(3600, 30 * 2 ** Math.min(failures - 5, 7)));

const derive = (pin: string, salt: Buffer, iterations: number) => promisify(pbkdf2)(pin, salt, iterations, 32, "sha256");

function wrap(dataKey: Buffer, kek: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, nonce);
  return Buffer.concat([nonce, c.update(dataKey), c.final(), c.getAuthTag()]);
}

/** The data key, or null when `kek` is wrong (a wrong PIN). */
function unwrap(wrapped: Buffer, kek: Buffer): Buffer | null {
  try {
    const d = createDecipheriv("aes-256-gcm", kek, wrapped.subarray(0, 12));
    d.setAuthTag(wrapped.subarray(wrapped.length - 16));
    return Buffer.concat([d.update(wrapped.subarray(12, wrapped.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

export function pinVault(dataDir: string, device: DeviceSeal, now: () => number = Date.now) {
  const file = path.join(dataDir, "pin.json");
  const read = (): VaultFile | null => {
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      return typeof v?.wrapped === "string" && typeof v?.salt === "string" ? v : null;
    } catch {
      return null;
    }
  };
  const write = (v: VaultFile) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(v));
    renameSync(`${file}.tmp`, file);
  };
  const waitSeconds = (v: VaultFile | null) => (v ? Math.max(0, Math.ceil((v.lockedUntil - now()) / 1000)) : 0);

  async function store(pin: string, dataKey: Buffer): Promise<void> {
    const salt = randomBytes(16);
    const pinSealed = wrap(dataKey, await derive(pin, salt, ITERATIONS));
    write({ wrapped: device.seal(pinSealed).toString("base64"), salt: salt.toString("base64"), iterations: ITERATIONS, failures: 0, lockedUntil: 0 });
  }

  /** The data key for `pin`, counting a wrong one (and the wait after too many) like the native app. */
  async function attempt(pin: unknown): Promise<Attempt & { dataKey?: Buffer }> {
    const v = read();
    if (!v) return { ok: false, waitSeconds: 0 };
    const wait = waitSeconds(v);
    if (wait > 0) return { ok: false, waitSeconds: wait };
    let dataKey: Buffer | null = null;
    if (validPin(pin)) {
      try {
        dataKey = unwrap(device.open(Buffer.from(v.wrapped, "base64")), await derive(pin, Buffer.from(v.salt, "base64"), v.iterations));
      } catch {
        dataKey = null; // DPAPI refused: another Windows user, or the file came from another computer
      }
    }
    if (!dataKey) {
      const failures = v.failures + 1;
      const backoff = backoffSeconds(failures);
      write({ ...v, failures, lockedUntil: now() + backoff * 1000 });
      return { ok: false, waitSeconds: backoff };
    }
    if (v.failures || v.lockedUntil) write({ ...v, failures: 0, lockedUntil: 0 });
    return { ok: true, key: dataKey.toString("base64"), dataKey };
  }

  return {
    status: () => {
      const v = read();
      return { isSet: v !== null, waitSeconds: waitSeconds(v), available: device.available() };
    },
    /** Turns the PIN on: a new data key, saved before the page seals any chat with it. */
    async enable(pin: unknown): Promise<string> {
      if (!validPin(pin)) throw new Error("The PIN must be 4 to 8 digits.");
      if (read()) throw new Error("A PIN is already set.");
      if (!device.available()) throw new Error("The system can't protect the key on this account (safeStorage unavailable).");
      const dataKey = randomBytes(32);
      await store(pin, dataKey);
      return dataKey.toString("base64");
    },
    unlock: async (pin: unknown): Promise<Attempt> => {
      const { dataKey: _, ...a } = await attempt(pin);
      return a;
    },
    /** A new PIN for the same data key (the chats aren't touched). False when `old` is wrong. */
    async change(old: unknown, next: unknown): Promise<boolean> {
      if (!validPin(next)) throw new Error("The PIN must be 4 to 8 digits.");
      const a = await attempt(old);
      if (!a.ok || !a.dataKey) return false;
      await store(next, a.dataKey);
      return true;
    },
    /** Off (after the page re-sealed the chats plain), or forgotten (after it erased them). */
    clear: () => rmSync(file, { force: true }),
  };
}

/**
 * Whether safeStorage really protects the key. On Linux without a keyring (GNOME Keyring, KWallet) it falls back to
 * "basic_text", a key hard-coded in Chromium: isEncryptionAvailable() still says yes, but anyone with the files could
 * open them, so no PIN there.
 */
export function sealAvailable(
  platform: NodeJS.Platform,
  s: { isEncryptionAvailable(): boolean; getSelectedStorageBackend?(): string }
): boolean {
  if (!s.isEncryptionAvailable()) return false;
  return platform !== "linux" || (s.getSelectedStorageBackend?.() ?? "basic_text") !== "basic_text";
}

export function register(ctx: HandlerContext): void {
  const { safeStorage } = require("electron") as typeof import("electron");
  const device: DeviceSeal = {
    available: () => sealAvailable(process.platform, safeStorage),
    seal: (b) => safeStorage.encryptString(b.toString("base64")),
    open: (b) => Buffer.from(safeStorage.decryptString(b), "base64"),
  };
  const vault = pinVault(path.dirname(ctx.roots.document), device);
  ctx.ipcMain.handle("pin-lock:status", () => vault.status());
  ctx.ipcMain.handle("pin-lock:enable", (_e, pin: unknown) => vault.enable(pin));
  ctx.ipcMain.handle("pin-lock:unlock", (_e, pin: unknown) => vault.unlock(pin));
  ctx.ipcMain.handle("pin-lock:change", (_e, old: unknown, next: unknown) => vault.change(old, next));
  ctx.ipcMain.handle("pin-lock:clear", () => vault.clear());
}
