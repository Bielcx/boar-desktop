/**
 * Not a test: screenshots of every screen at 1440x900 and 820x900, for the desktop-ui before/after report.
 *   BOAR_SHOTS_DIR=<dir> BOAR_SHOTS_PREFIX=ui-antes npx playwright test zz-shots
 */
import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, chatInput, completeSetup, launch, modelsMissing, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing || !process.env.BOAR_SHOTS_DIR, SKIP_REASON);

const SIZES = { largo: [1440, 900], estreito: [820, 900] } as const;

test("screens", async () => {
  const dir = process.env.BOAR_SHOTS_DIR!;
  const prefix = process.env.BOAR_SHOTS_PREFIX ?? "ui";
  fs.mkdirSync(dir, { recursive: true });
  const userData = tempUserData();
  const s = await launch(userData);
  const { app, page } = s;
  const size = (w: number, h: number) =>
    app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
  const both = async (name: string, prep?: (p: Page) => Promise<void>, undo?: (p: Page) => Promise<void>) => {
    for (const [label, [w, h]] of Object.entries(SIZES)) {
      await size(w, h);
      await page.waitForTimeout(600);
      if (prep) await prep(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(dir, `${prefix}-${name}-${label}.png`) });
      if (undo) await undo(page);
    }
  };
  const drawer = async (p: Page) => {
    const btn = p.getByLabel("Open Navigation Drawer");
    if (await btn.isVisible()) await btn.click();
  };
  const closeDrawer = async (p: Page) => p.getByText("New Research Session").click();
  const open = (item: string) => async (p: Page) => {
    await drawer(p);
    await p.getByText(item, { exact: true }).click();
  };
  const done = async (p: Page) => p.getByText("Done", { exact: true }).click();
  try {
    await page.getByText("English", { exact: true }).waitFor({ timeout: 60_000 });
    await both("wizard-idioma");
    await completeSetup(page, userData);
    await both("chat-vazio");
    await ask(page, "What is a black hole?");
    await page.getByText("Retrieved sources").waitFor({ timeout: 5 * 60_000 });
    await chatInput(page).waitFor();
    await both("chat-resposta");
    await both("menu", drawer, closeDrawer);
    await both("configuracoes", async (p) => {
      await open("Settings")(p);
      await p.getByText("Hardware Telemetry & Compliance", { exact: true }).click();
    }, done);
    await both("configuracoes-voz", async (p) => {
      await open("Settings")(p);
      await p.getByText("Voice Input Configuration", { exact: true }).click();
    }, done);
    await both("configuracoes-idioma", async (p) => {
      await open("Settings")(p);
      await p.getByText("Language", { exact: true }).click();
    }, done);
    await both("documentos", open("Knowledge"), done);
    await both("telemetria", open("Execution Telemetry"), done);
    await both("sobre", open("About & Info"), done);
    await both("ideias", open("Prompt Ideas"), async (p) => p.getByText("✕", { exact: true }).click());
  } finally {
    await app.close();
    rmUserData(userData);
  }
});
