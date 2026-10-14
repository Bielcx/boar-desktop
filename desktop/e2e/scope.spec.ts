/**
 * "Ask this document": right after importing a document the app offers to ask about it; the new conversation shows
 * the scope chip, answers from that document only and cites it; the chip's X brings back the whole library, and the
 * scope is saved with the conversation.
 */
import { expect, test, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, chatInput, completeSetup, launch, mockOpenDialog, modelsMissing, openDrawerItem, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

const PLAN = path.join(__dirname, "../bench/docs/household-emergency-plan.txt");

/** The window as it is (page.screenshot is slow on Electron). */
async function capture(app: ElectronApplication, file: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
}

test("import a document, ask only it, get it cited; the chip's X clears the scope", async ({}, testInfo) => {
  const shots = process.env.BOAR_E2E_SCREENSHOTS ?? testInfo.outputDir;
  fs.mkdirSync(shots, { recursive: true });
  const userData = tempUserData();
  const src = fs.mkdtempSync(path.join(path.dirname(userData), "boar-e2e-src-"));
  const plan = path.join(src, "household-emergency-plan.txt");
  fs.copyFileSync(PLAN, plan);

  const s = await launch(userData);
  const { app, page } = s;
  try {
    await completeSetup(page, userData);

    await openDrawerItem(page, "Knowledge");
    await page.getByPlaceholder("Collection name (e.g. Project Specs)").fill("Silva plan");
    await mockOpenDialog(app, [plan]);
    await page.getByText("Pick Files & Import").click();
    await expect(page.getByText("Ask this document", { exact: false })).toBeVisible({ timeout: 2 * 60_000 });
    await page.getByText("Ask about it now", { exact: false }).click();

    // A new conversation limited to the plan.
    await expect(page.getByTestId("scope-chip")).toContainText("Only in: Silva plan");
    await ask(page, "How much water do we store per person?");
    await page.getByText("Retrieved sources").waitFor({ timeout: 5 * 60_000 });
    await expect(chatInput(page)).toBeEditable({ timeout: 3 * 60_000 });
    await capture(app, path.join(shots, "a-scope-chip.png"));
    const reply = (await page.evaluate(() => document.body.innerText)).split("store per person?")[1];
    expect(reply).toMatch(/\b12\b/);
    expect(reply.split("Retrieved sources")[1]).toMatch(/household-emergency-plan|Silva plan/);

    // X: the whole library again, for this conversation too.
    await page.getByTestId("scope-clear").click();
    await expect(page.getByTestId("scope-chip")).toHaveCount(0);

    expect(s.errors).toEqual([]);
  } catch (e) {
    await capture(app, path.join(shots, "a-scope-failure.png")).catch(() => {});
    throw e;
  } finally {
    await app.close();
    rmUserData(userData);
    fs.rmSync(src, { recursive: true, force: true });
  }
});
