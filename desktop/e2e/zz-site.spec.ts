/**
 * Not a test: the animations of boarapp.com/desktop, as numbered frames (Playwright's recordVideo leaves Electron
 * blank). setup/ is the first-run wizard, paced to be read; pdf/ imports a demo PDF and asks about it. Plus layout.png.
 *   BOAR_SITE_DIR=<dir> npx playwright test zz-site
 * Then for each folder: ffmpeg -framerate $(cat <dir>/setup/fps.txt) -i <dir>/setup/%04d.png ... (see make-media.sh).
 */
import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { makePdf } from "../src/testing/pdf";
import { ask, chatInput, launch, MODELS, MODELS_DIR, mockOpenDialog, modelsMissing, openDrawerItem, rmUserData, SKIP_REASON, tempUserData, waitForChat } from "./helpers";

test.skip(modelsMissing || !process.env.BOAR_SITE_DIR, SKIP_REASON);

const [W, H] = [1280, 800];

/** Screenshots as fast as they come (~9/s) into dir until the returned stop() is awaited. */
function record(page: Page, dir: string): () => Promise<number> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  let on = true;
  const t0 = Date.now();
  const loop = (async () => {
    while (on) await page.screenshot({ path: path.join(dir, `${String(++n).padStart(4, "0")}.png`) });
  })();
  return async () => {
    on = false;
    await loop;
    fs.writeFileSync(path.join(dir, "fps.txt"), (n / ((Date.now() - t0) / 1000)).toFixed(2));
    return n;
  };
}

test("site media", async () => {
  test.setTimeout(20 * 60_000);
  const dir = process.env.BOAR_SITE_DIR!;
  const userData = tempUserData();
  const src = fs.mkdtempSync(path.join(path.dirname(userData), "boar-site-src-"));
  const pdf = path.join(src, "expedition-manual.pdf");
  fs.writeFileSync(pdf, makePdf([
    "Camp Tamandua expedition manual.",
    "Water: at Camp Tamandua, boil river water for 3 minutes before drinking it.",
    "Radio check-in with base camp every evening at 19:00.",
  ]));
  const { app, page } = await launch(userData);
  const pause = (ms: number) => page.waitForTimeout(ms);
  try {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H]);

    // ---- first run, paced ------------------------------------------------------------------------------
    await page.getByText("English", { exact: true }).waitFor({ timeout: 60_000 });
    let stop = record(page, path.join(dir, "setup"));
    await pause(1500);
    await page.getByText("English", { exact: true }).click();
    await pause(1800);
    // Seeded now, as completeSetup does: with the models there at launch the app would skip the wizard.
    const models = path.join(userData, "documents/models");
    fs.mkdirSync(models, { recursive: true });
    for (const f of MODELS) fs.linkSync(path.join(MODELS_DIR!, f), path.join(models, f));
    await page.getByText("Select Model Tier").click();
    await pause(1500);
    await page.getByText("Qwen2.5 1.5B", { exact: true }).click();
    await pause(1000);
    await page.getByText("Minimum", { exact: true }).click();
    await pause(1200);
    await page.getByText("Download and index").click();
    await page.getByText("Launch BOAR Terminal").waitFor({ timeout: 5 * 60_000 });
    await pause(1500);
    await page.getByText("Launch BOAR Terminal").click();
    await waitForChat(page);
    await pause(1500);
    console.log(`setup: ${await stop()} frames`);

    // ---- import a PDF and ask about it -------------------------------------------------------------------
    stop = record(page, path.join(dir, "pdf"));
    await pause(800);
    await openDrawerItem(page, "Knowledge");
    await pause(1000);
    const name = page.getByPlaceholder("Collection name (e.g. Project Specs)");
    await name.scrollIntoViewIfNeeded();
    await name.pressSequentially("Expedition", { delay: 70 });
    await mockOpenDialog(app, [pdf]);
    await pause(500);
    await page.getByText("Pick Files & Import").click();
    await page.getByText(/1 docs?\b/).waitFor({ timeout: 2 * 60_000 });
    await pause(1500);
    await page.getByText("Done", { exact: true }).first().click();
    await pause(700);
    const q = "How long should I boil river water at Camp Tamandua?";
    await chatInput(page).pressSequentially(q, { delay: 45 });
    await ask(page, q);
    await page.getByText("Retrieved sources").waitFor({ timeout: 5 * 60_000 });
    await chatInput(page).waitFor();
    await pause(3000);
    console.log(`pdf: ${await stop()} frames`);

    // ---- the desktop layout: sidebar with history, reading column ---------------------------------------
    await ask(page, "What is a black hole?");
    await page.getByText("Retrieved sources").nth(1).waitFor({ timeout: 5 * 60_000 });
    await chatInput(page).waitFor();
    await pause(1500);
    await page.screenshot({ path: path.join(dir, "layout.png") });
  } finally {
    await app.close();
    rmUserData(userData);
    fs.rmSync(src, { recursive: true, force: true });
  }
});
