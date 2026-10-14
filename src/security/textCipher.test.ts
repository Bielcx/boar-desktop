import { describe, expect, it } from "vitest";
import { aesTextCipher, isSealed, LOCKED, lockedCipher, plainCipher } from "./textCipher";

const key = () => crypto.getRandomValues(new Uint8Array(32));

describe("chat text cipher (the native app's enc1 format)", () => {
  it("sealed text round-trips, each seal differs, and the wrong key shows the lock", async () => {
    const c = await aesTextCipher(key());
    const a = await c.seal("Hello, boar");
    const b = await c.seal("Hello, boar");
    expect(isSealed(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("boar");
    expect(await c.open(a)).toBe("Hello, boar");
    expect(await c.open("plain from before")).toBe("plain from before");
    expect(await (await aesTextCipher(key())).open(a)).toBe(LOCKED);
    expect(await plainCipher.open(a)).toBe(LOCKED);
  });

  it("is nonce | ciphertext | 16-byte tag in base64, as the native app writes it", async () => {
    const sealed = await (await aesTextCipher(key())).seal("abc");
    const raw = atob(sealed.slice("enc1:".length));
    expect(raw.length).toBe(12 + 3 + 16);
  });

  it("while locked nothing can be written, so nothing lands on disk unsealed", async () => {
    await expect(lockedCipher.seal("secret")).rejects.toThrow(/locked/);
    expect(await lockedCipher.open("plain")).toBe("plain");
  });
});
