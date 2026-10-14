// The chats sealed with the PIN's key (src/services/chatHistory.ts + src/security/textCipher.ts) on the real database
// (node:sqlite through the desktop shims): turning the PIN on leaves no chat text readable anywhere in the files,
// the app reads it back with the key, sees only the lock without it, and can't write while locked.
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDesktop } from "./setup";

vi.mock("expo-sqlite", () => import("../src/shims/expo-sqlite"));
vi.mock("expo-file-system", () => import("../src/shims/expo-file-system"));
vi.mock("expo-file-system/legacy", () => import("../src/shims/expo-file-system-legacy"));

const env = setupDesktop();

const SECRETS = ["Lisbon", "SIM card", "taxi", "airport", "Planning a trip"];

describe("chats sealed with the PIN", () => {
  it("turning the PIN on leaves no chat text in the database files, and off brings it back", async () => {
    const chats = await import("../../src/services/chatHistory");
    const { aesTextCipher, lockedCipher, plainCipher, LOCKED } = await import("../../src/security/textCipher");

    const s = await chats.createSession("Trip to Lisbon");
    await chats.addMessage(s.id, "user", "Where can I buy a SIM card?", "u1");
    await chats.addMessage(s.id, "assistant", "At the airport.", "a1");
    await chats.setMessageMeta("a1", JSON.stringify({ receipt: { totalMs: 1, ttftMs: 1, tokPerSec: 1, tokens: 1, model: "Lisbon-1B" } }));
    await chats.setSessionSummary(s.id, "Planning a trip.");

    const files = () => {
      const dir = join(env.dataDir, "documents", "SQLite");
      return ["aoair_knowledge.db", "aoair_knowledge.db-wal"].map((f) => join(dir, f)).filter(existsSync).map((f) => readFileSync(f).toString("latin1"));
    };
    expect(files().join("")).toContain("SIM card"); // plain before the PIN

    const aes = await aesTextCipher(crypto.getRandomValues(new Uint8Array(32)));
    await chats.resealAllChats(plainCipher, aes);
    chats.setChatCipher(aes);
    await chats.addMessage(s.id, "user", "And a taxi?", "u2");

    const raw = files().join("");
    for (const secret of SECRETS) expect(raw, secret).not.toContain(secret);

    expect((await chats.getMessages(s.id)).map((m) => m.text)).toEqual(["Where can I buy a SIM card?", "At the airport.", "And a taxi?"]);
    expect((await chats.listSessions())[0]).toMatchObject({ title: "Trip to Lisbon", summary: "Planning a trip." });
    expect((await chats.getMessages(s.id))[1].meta).toContain("Lisbon-1B");

    // Locked (the PIN not entered yet): only the lock shows, and nothing can be written unsealed.
    chats.setChatCipher(lockedCipher);
    expect((await chats.getMessages(s.id))[0].text).toBe(LOCKED);
    await expect(chats.addMessage(s.id, "user", "leak?", "u3")).rejects.toThrow(/locked/);
    expect(files().join("")).not.toContain("leak?");

    // Off: back to plain text.
    await chats.resealAllChats(aes, plainCipher);
    chats.setChatCipher(plainCipher);
    expect((await chats.getMessages(s.id)).map((m) => m.text)).toContain("And a taxi?");
    expect(files().join("")).toContain("And a taxi?");
  }, 60_000);
});
