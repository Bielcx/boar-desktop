/**
 * Agent profiles: create one limited to an imported document, with its own boar; start a conversation with it (the
 * header shows its name, the scope chip its document) and get the document cited; the profile survives a restart
 * and can be deleted. Recent sessions name the profile; a Custom tone keeps the profile's own prompt.
 */
import { expect, test, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, chatInput, completeSetup, launch, mockOpenDialog, modelsMissing, openDrawer, openDrawerItem, rmUserData, SKIP_REASON, tempUserData, waitForChat } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

const MANUAL = path.join(__dirname, "../bench/docs/manual-gerador.txt");

async function capture(app: ElectronApplication, file: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
}

test("create a profile on a document, chat with it, keep it across a restart, delete it", async ({}, testInfo) => {
  const shots = process.env.BOAR_E2E_SCREENSHOTS ?? testInfo.outputDir;
  fs.mkdirSync(shots, { recursive: true });
  const userData = tempUserData();
  const src = fs.mkdtempSync(path.join(path.dirname(userData), "boar-e2e-src-"));
  const manual = path.join(src, "manual-gerador.txt");
  fs.copyFileSync(MANUAL, manual);

  let s = await launch(userData);
  try {
    await completeSetup(s.page, userData);
    await openDrawerItem(s.page, "Knowledge");
    await s.page.getByPlaceholder("Collection name (e.g. Project Specs)").fill("Generator manual");
    await mockOpenDialog(s.app, [manual]);
    await s.page.getByText("Pick Files & Import").click();
    await expect(s.page.getByText("Ask about it now", { exact: false })).toBeVisible({ timeout: 2 * 60_000 });
    await s.page.getByText("Done", { exact: true }).click();

    // ---- create -----------------------------------------------------------------------------------
    await openDrawerItem(s.page, "Profiles");
    await s.page.getByText("Create profile", { exact: false }).click();
    await s.page.getByPlaceholder("E.g. House boar").fill("Generator boar");
    await s.page.getByText("Thorough & Detailed", { exact: false }).click();
    await s.page.getByText("📄 Generator manual").click();
    await s.page.getByLabel("Grown boar").click();
    await capture(s.app, path.join(shots, "a-profile-edit.png"));
    await s.page.getByText("Save", { exact: true }).click();
    await expect(s.page.getByText("Generator boar", { exact: true })).toBeVisible();
    await capture(s.app, path.join(shots, "a-profiles.png"));

    // ---- chat with it -------------------------------------------------------------------------------
    await s.page.getByText("💬 Chat", { exact: true }).click();
    await expect(s.page.getByTestId("chat-title")).toHaveText("Generator boar");
    await expect(s.page.getByTestId("scope-chip")).toContainText("Only in: Generator manual");
    await ask(s.page, "Qual óleo usar no gerador?");
    await s.page.getByText("Retrieved sources").waitFor({ timeout: 5 * 60_000 });
    await expect(chatInput(s.page)).toBeEditable({ timeout: 3 * 60_000 });
    await capture(s.app, path.join(shots, "a-profile-chat.png"));
    const reply = (await s.page.evaluate(() => document.body.innerText)).split("usar no gerador?")[1];
    expect(reply).toMatch(/10W-?30/i);
    expect(reply.split("Retrieved sources")[1]).toContain("manual-gerador");
    expect(s.errors).toEqual([]);

    // ---- a restart keeps the profile; the empty chat offers it; delete ------------------------------
    await s.app.close();
    s = await launch(userData);
    await waitForChat(s.page);
    await expect(s.page.getByText("🐗 Generator boar", { exact: true })).toBeVisible();
    await openDrawer(s.page);
    await expect(s.page.getByText(/^🐗 Generator boar · /)).toBeVisible(); // the conversation says its profile
    await openDrawerItem(s.page, "Profiles");

    // A Custom tone gets this profile's own prompt.
    await s.page.getByText("Edit", { exact: true }).click();
    await s.page.getByText("⚙️ Custom", { exact: true }).click();
    await s.page.getByLabel("Write your own system prompt…").fill("Answer like a pirate.");
    await s.page.getByText("Save", { exact: true }).click();
    await s.page.getByText("Edit", { exact: true }).click();
    await expect(s.page.getByLabel("Write your own system prompt…")).toHaveValue("Answer like a pirate.");
    await s.page.getByText("Remove", { exact: true }).click();
    await expect.poll(() => s.dialogs.length).toBe(1);
    await expect(s.page.getByText("Generator boar", { exact: true })).toHaveCount(0);
    expect(s.errors).toEqual([]);
  } catch (e) {
    await capture(s.app, path.join(shots, "a-profiles-failure.png")).catch(() => {});
    throw e;
  } finally {
    await s.app.close();
    rmUserData(userData);
    fs.rmSync(src, { recursive: true, force: true });
  }
});
