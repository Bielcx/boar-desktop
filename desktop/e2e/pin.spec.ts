/**
 * The PIN (Settings › Security): set it, and the chats on disk hold no readable text; the next start shows the lock
 * screen, a wrong PIN is refused, the right one opens the chat with its history; "Forgot the PIN?" erases the chats
 * and opens BOAR without one.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, chatInput, completeSetup, launch, modelsMissing, openDrawer, openDrawerItem, rmUserData, SKIP_REASON, tempUserData, waitForChat } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

const QUESTION = "In two sentences, what is a volcano?";

test("a PIN seals the chats, locks the next start, and 'forgot' erases them", async () => {
  const userData = tempUserData();
  let s = await launch(userData);
  try {
    await completeSetup(s.page, userData);
    await ask(s.page, QUESTION);
    await s.page.getByLabel("Copy response").waitFor({ timeout: 5 * 60_000 });
    await expect(chatInput(s.page)).toBeEditable({ timeout: 3 * 60_000 });

    await openDrawerItem(s.page, "Settings");
    await s.page.getByText("Security (PIN)", { exact: true }).click();
    await s.page.getByLabel("New PIN (4 to 8 digits)").fill("4821");
    await s.page.getByLabel("Repeat the new PIN").fill("4821");
    await s.page.getByText("Set PIN", { exact: true }).click();
    await expect(s.page.getByText("PIN set. Your chats are sealed.")).toBeVisible({ timeout: 30_000 });
    await s.app.close();

    // Nothing the chat said is readable in the files.
    const sqlite = path.join(userData, "documents", "SQLite");
    const raw = fs.readdirSync(sqlite).map((f) => fs.readFileSync(path.join(sqlite, f)).toString("latin1")).join("");
    expect(raw).not.toContain("volcano");

    s = await launch(userData);
    await expect(s.page.getByText("BOAR is locked")).toBeVisible({ timeout: 60_000 });
    await s.page.getByLabel("PIN").fill("1111");
    await s.page.getByText("Unlock", { exact: true }).click();
    await expect(s.page.getByText("Wrong PIN.")).toBeVisible();
    await s.page.getByLabel("PIN").fill("4821");
    await s.page.getByText("Unlock", { exact: true }).click();
    await waitForChat(s.page);
    await openDrawer(s.page);
    await s.page.getByText("just now").first().click();
    await expect(s.page.getByText(QUESTION).first()).toBeVisible();
    expect(s.errors).toEqual([]);
    await s.app.close();

    s = await launch(userData);
    await expect(s.page.getByText("BOAR is locked")).toBeVisible({ timeout: 60_000 });
    await s.page.getByText("Forgot the PIN?").click();
    await s.page.getByText("Erase chats", { exact: true }).click();
    await waitForChat(s.page);
    await openDrawer(s.page);
    await expect(s.page.getByText("just now")).toHaveCount(0);
    expect(fs.existsSync(path.join(userData, "pin.json"))).toBe(false);
    expect(s.errors).toEqual([]);
  } finally {
    await s.app.close();
    rmUserData(userData);
  }
});
