/**
 * Watched folder ("javali de plantão"): Settings › Watched folders picks a folder (Electron's dialog, mocked from main),
 * a .txt dropped into it is imported on its own, a system notification says so, and a question about its unique
 * content cites it. Then "keep running in the tray": closing the window hides it instead of quitting.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, chatInput, completeSetup, launch, mockOpenDialog, modelsMissing, openDrawerItem, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

test("a .txt dropped into a watched folder is imported, announced and cited; close-to-tray hides the window", async ({}, testInfo) => {
  const shots = process.env.BOAR_E2E_SCREENSHOTS ?? testInfo.outputDir;
  fs.mkdirSync(shots, { recursive: true });
  const userData = tempUserData();
  const watched = path.join(fs.mkdtempSync(path.join(path.dirname(userData), "boar-e2e-watch-")), "Obra");
  fs.mkdirSync(watched);
  const s = await launch(userData);
  const { app, page } = s;
  const capture = async (name: string) =>
    fs.writeFileSync(
      path.join(shots, name),
      Buffer.from(
        await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")),
        "base64"
      )
    );
  try {
    await completeSetup(page, userData);
    // Notifications are system toasts, outside the page: record their text from main.
    await app.evaluate(({ Notification }) => {
      const g = globalThis as unknown as { shown: string[] };
      g.shown = [];
      const show = Notification.prototype.show;
      Notification.prototype.show = function (this: Electron.Notification) {
        g.shown.push(this.body);
        return show.call(this);
      };
    });

    // ---- Settings › Watched folders: pick the folder ---------------------------------------------------
    await openDrawerItem(page, "Settings");
    await page.getByText("Watched folders (boar on duty)", { exact: true }).click();
    await expect(page.getByText("No watched folders.")).toBeVisible();
    await mockOpenDialog(app, [watched]);
    await page.getByText("Watch a folder", { exact: false }).click();
    await expect(page.getByText(watched, { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    await capture("folder-watch-settings.png");
    await page.getByText("Done", { exact: true }).click();

    // ---- drop a note into the folder: imported by itself, announced ---------------------------------------
    fs.writeFileSync(
      path.join(watched, "zebra-ledger.txt"),
      "Zebra Ledger. The Zebra Ledger is the site diary of the Obra project. It records that the concrete slab " +
        "of the Obra project was poured on 17 March, using exactly 42 cubic metres of concrete.\n"
    );
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown), { timeout: 2 * 60_000 })
      .toEqual(["BOAR imported 1 document from Obra — ready for questions"]);
    // The copy main made for the import is gone once imported.
    expect(fs.readdirSync(path.join(userData, "app-cache/FolderWatch"))).toEqual([]);

    // ---- ask about it ---------------------------------------------------------------------------------
    await ask(page, "According to the Zebra Ledger, how many cubic metres of concrete went into the Obra slab?");
    await page.getByText("Retrieved sources").waitFor({ timeout: 5 * 60_000 });
    await expect(chatInput(page)).toBeEditable({ timeout: 3 * 60_000 });
    await capture("folder-watch-cited.png");
    const reply = (await page.evaluate(() => document.body.innerText)).split("went into the Obra slab?")[1];
    expect(reply).toContain("42");
    expect(reply.split("Retrieved sources")[1]).toMatch(/zebra-ledger|Obra/i);

    // ---- keep running in the tray: closing hides the window ----------------------------------------------
    await openDrawerItem(page, "Settings");
    await page.getByText("Watched folders (boar on duty)", { exact: true }).click();
    await page.getByRole("switch").last().click();
    await page.waitForTimeout(500);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);

    expect(s.errors).toEqual([]);
  } catch (e) {
    await capture("folder-watch-failure.png").catch(() => {});
    throw e;
  } finally {
    await app.close();
    rmUserData(userData);
    fs.rmSync(path.dirname(watched), { recursive: true, force: true });
  }
});
