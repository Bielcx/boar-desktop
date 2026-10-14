/**
 * Everything lives in userData: after setup and one question, closing and relaunching on the same folder goes
 * straight to chat (no wizard) and the session is in the drawer's history, with its messages; the window keeps
 * its size and position (desktop/src/main/window-state.ts).
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, chatInput, completeSetup, launch, modelsMissing, openDrawer, rmUserData, SKIP_REASON, tempUserData, waitForChat } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

const QUESTION = "In two sentences, what is a volcano?"; // not one of the empty-state suggestions

test("relaunch on the same userData: straight to chat, history kept", async ({}, testInfo) => {
  const shots = process.env.BOAR_E2E_SCREENSHOTS ?? testInfo.outputDir;
  fs.mkdirSync(shots, { recursive: true });
  const userData = tempUserData();
  let s = await launch(userData);
  try {
    await completeSetup(s.page, userData);
    await ask(s.page, QUESTION);
    await s.page.getByLabel("Copy response").waitFor({ timeout: 5 * 60_000 }); // shown once the reply is done
    await expect(chatInput(s.page)).toBeEditable({ timeout: 3 * 60_000 });
    expect(s.errors).toEqual([]);
    const bounds = { x: 80, y: 60, width: 1100, height: 760 };
    await s.app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), bounds);
    await s.app.close();

    s = await launch(userData);
    const { page } = s;
    await waitForChat(page);
    const restored = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(restored[k] - bounds[k]), k).toBeLessThanOrEqual(2);
    await expect(page.getByText("Select Model Tier")).toHaveCount(0);
    await expect(page.getByText(QUESTION)).toHaveCount(0); // a new, empty session
    await openDrawer(page);
    await expect(page.getByText("Recent sessions")).toBeVisible();
    // The only session; its title ("New chat" or a generated one) depends on whether the background title
    // generation finished before the close, so click its timestamp.
    await page.getByText("just now").first().click();
    await expect(page.getByLabel("Copy response")).toBeVisible(); // the reply came back too
    await expect(page.getByLabel("Performance details")).toHaveText(/tok\/s/); // and its receipt
    await expect(page.getByText(QUESTION).first()).toBeVisible();
    await page.screenshot({ path: path.join(shots, "wave3-qa-relaunch-history.png") });
    expect(s.errors).toEqual([]);
  } catch (e) {
    await s.page.screenshot({ path: path.join(shots, "wave3-qa-relaunch-failure.png") }).catch(() => {});
    throw e;
  } finally {
    await s.app.close();
    rmUserData(userData);
  }
});
