/**
 * Not a test: the README's pictures. One session on a fresh userData: setup, then a question and its streamed answer
 * as numbered frames (frames/0001.png…, with frames/fps.txt; Playwright's recordVideo leaves Electron blank), then
 * screenshots.
 *   BOAR_README_DIR=<dir> npx playwright test zz-readme
 * docs/readme/make-media.sh turns that folder into docs/readme/*.{gif,png}.
 */
import { _electron, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, chatInput, completeSetup, DESKTOP, modelsMissing, openDrawerItem, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing || !process.env.BOAR_README_DIR, SKIP_REASON);

const [W, H] = [1280, 800];
const QUESTION = process.env.BOAR_README_QUESTION ?? "How do black holes form?";

test("readme", async () => {
  test.setTimeout(20 * 60_000);
  const dir = process.env.BOAR_README_DIR!;
  fs.mkdirSync(dir, { recursive: true });
  const userData = tempUserData();
  const t0 = Date.now();
  const mark = (what: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);
  const app = await _electron.launch({ args: [DESKTOP], env: { ...process.env, BOAR_USER_DATA: userData } });
  const shot = async (p: Page, name: string) => {
    await p.waitForTimeout(700);
    await p.screenshot({ path: path.join(dir, `${name}.png`) });
    mark(`shot ${name}`);
  };
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H]);
    await page.getByText("English", { exact: true }).waitFor({ timeout: 60_000 });
    await shot(page, "setup");
    await completeSetup(page, userData);
    mark("chat ready");

    // Frames as fast as screenshots come (~10/s), until stop(); fps.txt is the rate actually reached.
    const frames = path.join(dir, "frames");
    fs.rmSync(frames, { recursive: true, force: true });
    fs.mkdirSync(frames);
    let n = 0;
    let recording = true;
    const started = Date.now();
    const loop = (async () => {
      while (recording) await page.screenshot({ path: path.join(frames, `${String(++n).padStart(4, "0")}.png`) });
    })();
    const stop = async () => {
      recording = false;
      await loop;
      fs.writeFileSync(path.join(frames, "fps.txt"), (n / ((Date.now() - started) / 1000)).toFixed(2));
    };
    await page.waitForTimeout(1200);
    await chatInput(page).pressSequentially(QUESTION, { delay: 70 });
    await page.waitForTimeout(400);
    await ask(page, QUESTION);
    await page.getByText("Retrieved sources").waitFor({ timeout: 5 * 60_000 });
    await chatInput(page).waitFor();
    await page.waitForTimeout(3000);
    await stop();
    mark(`answered, ${n} frames`);
    await shot(page, "chat");

    for (const [item, name] of [["Knowledge", "knowledge"], ["Profiles", "profiles"], ["Settings", "settings"]] as const) {
      await openDrawerItem(page, item);
      await shot(page, name);
      await page.getByText("Done", { exact: true }).first().click();
    }
  } finally {
    await app.close();
    rmUserData(userData);
  }
});
