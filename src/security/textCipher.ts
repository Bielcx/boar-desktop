/**
 * How chat text is stored (the native app's TextCipher.kt, same format): as is, or sealed with the PIN's data key as
 * "enc1:<base64(nonce|ciphertext|tag)>", AES-256-GCM with a random 12-byte nonce per value. Text written before the
 * PIN was set (no prefix) opens as is, so turning the PIN on can re-seal rows in place.
 *
 * WebCrypto (crypto.subtle): the desktop page and Node have it; the Expo app on Android doesn't, and never sets a PIN.
 */
export interface TextCipher {
  seal(plain: string): Promise<string>;
  open(stored: string): Promise<string>;
}

export const PREFIX = "enc1:";
/** What a sealed value shows when it can't be opened (wrong key, or no PIN entered). */
export const LOCKED = "🔒";

export const isSealed = (s: string | null | undefined): boolean => typeof s === "string" && s.startsWith(PREFIX);

/** No PIN: stored as written. Text sealed earlier shows the lock. */
export const plainCipher: TextCipher = {
  seal: async (plain) => plain,
  open: async (stored) => (isSealed(stored) ? LOCKED : stored),
};

/**
 * A PIN is set but not entered yet: nothing opens, and nothing may be written, since it would land on disk unsealed.
 * A write while locked fails instead of leaking.
 */
export const lockedCipher: TextCipher = {
  seal: async () => {
    throw new Error("Chats are locked: enter the PIN first.");
  },
  open: plainCipher.open,
};

const toBase64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Sealed with the PIN's 32-byte data key. */
export async function aesTextCipher(key: Uint8Array): Promise<TextCipher> {
  const k = await crypto.subtle.importKey("raw", key.slice(), "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async seal(plain) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, new TextEncoder().encode(plain)));
      const out = new Uint8Array(12 + ct.length);
      out.set(nonce);
      out.set(ct, 12);
      return PREFIX + toBase64(out);
    },
    async open(stored) {
      if (!isSealed(stored)) return stored;
      try {
        const b = fromBase64(stored.slice(PREFIX.length));
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, k, b.slice(12));
        return new TextDecoder().decode(pt);
      } catch {
        return LOCKED;
      }
    },
  };
}
