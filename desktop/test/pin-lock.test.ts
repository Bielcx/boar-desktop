// The PIN's vault in main (src/main/handlers/pin-lock.ts): the data key sealed with the PIN and a device key (DPAPI in
// the app, a stand-in here), wrong tries and the wait after them, and nothing a copy of pin.json could be opened with.
import { describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffSeconds, pinVault, validPin, type DeviceSeal } from "../src/main/handlers/pin-lock";

/** A device key as DPAPI behaves: what one account sealed, another can't open. */
function device(): DeviceSeal {
  const key = randomBytes(32);
  return {
    available: () => true,
    seal: (b) => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, c.update(b), c.final(), c.getAuthTag()]);
    },
    open: (b) => {
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(b.length - 16));
      return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
    },
  };
}

const dir = () => mkdtempSync(join(tmpdir(), "boar-pin-"));

describe("PIN vault", () => {
  it("the right PIN opens the data key, a wrong one doesn't, and pin.json holds neither", async () => {
    const d = dir();
    const v = pinVault(d, device());
    expect(v.status()).toMatchObject({ isSet: false });
    const key = await v.enable("4821");
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(v.status()).toMatchObject({ isSet: true, waitSeconds: 0 });
    expect(await v.unlock("4821")).toEqual({ ok: true, key });
    expect(await v.unlock("4822")).toEqual({ ok: false, waitSeconds: 0 });
    const file = readFileSync(join(d, "pin.json"), "utf8");
    expect(file).not.toContain("4821");
    expect(file).not.toContain(key);
    await expect(v.enable("1111")).rejects.toThrow(/already/);
  }, 30_000);

  it("after 5 wrong PINs it makes you wait, doubling, and the right PIN resets the count", async () => {
    let t = 1_000_000;
    const v = pinVault(dir(), device(), () => t);
    await v.enable("4821");
    for (let i = 0; i < 4; i++) expect(await v.unlock("0000")).toEqual({ ok: false, waitSeconds: 0 });
    expect(await v.unlock("0000")).toEqual({ ok: false, waitSeconds: 30 });
    expect(await v.unlock("4821")).toEqual({ ok: false, waitSeconds: 30 }); // even the right one waits
    t += 30_000;
    expect(await v.unlock("0000")).toEqual({ ok: false, waitSeconds: 60 });
    t += 60_000;
    expect((await v.unlock("4821")).ok).toBe(true);
    expect(await v.unlock("0000")).toEqual({ ok: false, waitSeconds: 0 }); // counting from zero again
  }, 60_000);

  it("a copy of the files on another account (another device key) can't be opened, even with the PIN", async () => {
    const d = dir();
    await pinVault(d, device()).enable("4821");
    expect((await pinVault(d, device()).unlock("4821")).ok).toBe(false);
  }, 30_000);

  it("changing the PIN keeps the data key; clearing it turns the PIN off", async () => {
    const v = pinVault(dir(), device());
    const key = await v.enable("4821");
    expect(await v.change("1111", "90210")).toBe(false);
    expect(await v.change("4821", "90210")).toBe(true);
    expect(await v.unlock("4821")).toMatchObject({ ok: false });
    expect(await v.unlock("90210")).toEqual({ ok: true, key });
    v.clear();
    expect(v.status().isSet).toBe(false);
  }, 30_000);

  it("PIN rules and the wait after wrong tries, as the native app", () => {
    expect(validPin("1234") && validPin("12345678")).toBe(true);
    expect(validPin("123") || validPin("12a4") || validPin("123456789") || validPin(1234)).toBe(false);
    expect([backoffSeconds(4), backoffSeconds(5), backoffSeconds(6), backoffSeconds(40)]).toEqual([0, 30, 60, 3600]);
  });
});
