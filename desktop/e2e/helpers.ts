/**
 * Shared bits for the Electron e2e specs: launch the built app on a given userData, collect page errors and
 * dialogs, and run the first-run setup with hard-linked models (see chat.spec.ts for the why of each step).
 */
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DESKTOP = path.join(__dirname, "..");
export const MODELS_DIR = process.env.BOAR_TEST_MODELS_DIR;
export const MODELS = ["qwen2.5-1.5b-instruct-q4km.gguf", "embedding.gguf"];
export const modelsMissing = !MODELS_DIR || !MODELS.every((f) => fs.existsSync(path.join(MODELS_DIR, f)));
export const SKIP_REASON = "set BOAR_TEST_MODELS_DIR to a folder with " + MODELS.join(" and ");

export function tempUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "boar-e2e-"));
}

export type Session = {
  app: ElectronApplication;
  page: Page;
  errors: string[];
  dialogs: Array<{ type: string; message: string }>;
  /** What the next dialog does: accept (OK) or dismiss (Cancel). */
  dialogAnswer: { accept: boolean };
};

/** `args`: extra Chromium/Electron switches (e.g. a fake microphone, voice.spec.ts). */
export async function launch(userData: string, args: string[] = []): Promise<Session> {
  // BOAR_E2E_EXE=release/win-unpacked/BOAR.exe (relative to desktop/ or absolute): run the packaged app (npm run dist)
  // instead of `electron .`.
  const exe = process.env.BOAR_E2E_EXE;
  if (!exe) expect(fs.existsSync(path.join(DESKTOP, "web-dist/index.html")), "run `npm run build:web` first").toBe(true);
  const env = { ...process.env, BOAR_USER_DATA: userData };
  const app = await _electron.launch(exe ? { executablePath: path.resolve(DESKTOP, exe), args, env } : { args: [DESKTOP, ...args], env });
  const page = await app.firstWindow();
  const s: Session = { app, page, errors: [], dialogs: [], dialogAnswer: { accept: true } };
  page.on("pageerror", (e) => s.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && s.errors.push(`console.error: ${m.text()}`));
  page.on("dialog", (d) => {
    s.dialogs.push({ type: d.type(), message: d.message() });
    void (s.dialogAnswer.accept ? d.accept() : d.dismiss());
  });
  return s;
}

/** First-run wizard: English, Qwen2.5 1.5B, Minimum tier; returns once the chat input is editable. */
export async function completeSetup(page: Page, userData: string): Promise<void> {
  await page.getByText("English", { exact: true }).click({ timeout: 60_000 });
  await page.getByText("Select Model Tier").waitFor();
  const models = path.join(userData, "documents/models");
  fs.mkdirSync(models, { recursive: true });
  for (const f of MODELS) fs.linkSync(path.join(MODELS_DIR!, f), path.join(models, f));
  await page.getByText("Select Model Tier").click();
  await page.getByText("Qwen2.5 1.5B", { exact: true }).click();
  await page.getByText("Minimum", { exact: true }).click();
  await page.getByText("Download and index").click();
  await page.getByText("Launch BOAR Terminal").click({ timeout: 5 * 60_000 });
  await waitForChat(page);
}

export const chatInput = (page: Page) => page.getByPlaceholder("Research question…");

export async function waitForChat(page: Page): Promise<void> {
  await expect(chatInput(page)).toBeEditable({ timeout: 3 * 60_000 });
}

export async function ask(page: Page, question: string): Promise<void> {
  await chatInput(page).fill(question);
  await chatInput(page).press("Enter");
}

/** Wide window (src/ui-android/desktopLayout.tsx): the drawer is a fixed sidebar (☰ hides it); narrower, it slides in. */
export const WIDE_MIN_WIDTH = 1000;

export async function openDrawer(page: Page): Promise<void> {
  const burger = page.getByLabel("Open Navigation Drawer");
  if (!(await page.evaluate((min) => window.innerWidth >= min, WIDE_MIN_WIDTH))) await burger.click();
}

export async function openDrawerItem(page: Page, item: string): Promise<void> {
  await openDrawer(page);
  await page.getByText(item, { exact: true }).click();
}

export async function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
}

/** Makes the next dialog.showOpenDialog in main return these files (no native dialog shows). */
export async function mockOpenDialog(app: ElectronApplication, filePaths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog;
  }, filePaths);
}

export function rmUserData(userData: string): void {
  fs.rmSync(userData, { recursive: true, force: true }); // removes the links, not the shared model files
}
