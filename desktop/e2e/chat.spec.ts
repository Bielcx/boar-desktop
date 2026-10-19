/**
 * End to end, in the real Electron app (dist/ + web-dist/): first-run setup -> chat -> a streamed answer with
 * citations from the bundled corpus, then the desktop Alert/Share replacements (src/shims/rn-alert.ts, rn-share.ts).
 *
 *   BOAR_TEST_MODELS_DIR=C:/path/to/models npm run e2e     (needs `npm run build:web` once)
 *   BOAR_E2E_SCREENSHOTS=<dir>                             where the screenshots go (default: test output dir)
 *
 * The models dir must hold qwen2.5-1.5b-instruct-q4km.gguf and embedding.gguf (the catalog's files). They are
 * hard-linked into a fresh temp userData, so nothing is downloaded or copied; it must be on the same drive as
 * the temp folder.
 */
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDrawer } from "./helpers";

const DESKTOP = path.join(__dirname, "..");
const MODELS_DIR = process.env.BOAR_TEST_MODELS_DIR;
// Filenames under documents/ from src/models/manifest.ts (compact answer model + required embedding model).
const MODELS = ["qwen2.5-1.5b-instruct-q4km.gguf", "embedding.gguf"];

test.skip(
  !MODELS_DIR || !MODELS.every((f) => fs.existsSync(path.join(MODELS_DIR, f))),
  "set BOAR_TEST_MODELS_DIR to a folder with " + MODELS.join(" and ")
);

test("first run -> chat answer with citations, Alert and Share on desktop", async ({}, testInfo) => {
  expect(fs.existsSync(path.join(DESKTOP, "web-dist/index.html")), "run `npm run build:web` first").toBe(true);
  const shots = process.env.BOAR_E2E_SCREENSHOTS ?? testInfo.outputDir;
  fs.mkdirSync(shots, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "boar-e2e-"));
  const t0 = Date.now();
  const mark = (what: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);

  const app: ElectronApplication = await _electron.launch({
    args: [DESKTOP],
    env: { ...process.env, BOAR_USER_DATA: userData },
  });
  const errors: string[] = [];
  const dialogs: Array<{ type: string; message: string }> = [];
  let page: Page | undefined;
  try {
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`console.error: ${m.text()}`));
    page.on("dialog", (d) => {
      dialogs.push({ type: d.type(), message: d.message() });
      void d.accept();
    });

    // ---- first-run setup ---------------------------------------------------------------------------
    // English regardless of the machine's locale, so the selectors below hold.
    await page.getByText("English", { exact: true }).click({ timeout: 60_000 });
    await page.getByText("Select Model Tier").waitFor();
    // Seeded only now: with the models already there at launch the app skips the wizard (App.tsx). The wizard
    // re-scans when "Download and index" is pressed, finds both files at full size and downloads nothing.
    const models = path.join(userData, "documents/models");
    fs.mkdirSync(models, { recursive: true });
    for (const f of MODELS) fs.linkSync(path.join(MODELS_DIR!, f), path.join(models, f));
    await page.getByText("Select Model Tier").click();
    await page.getByText("Qwen2.5 1.5B", { exact: true }).click();
    await page.getByText("Minimum", { exact: true }).click();
    await page.getByText("Download and index").click();
    // Indexing embeds the bundled 300-article corpus with the real embedding model (node-llama-cpp in main).
    await page.getByText("Launch BOAR Terminal").click({ timeout: 5 * 60_000 });
    mark("setup complete");

    // ---- chat --------------------------------------------------------------------------------------
    const input = page.getByPlaceholder("Research question…");
    await expect(input).toBeEditable({ timeout: 3 * 60_000 }); // editable once the answer model is loaded
    mark("model loaded");

    // Count streamed tokens where they leave the main process, and sample the page while they arrive.
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const send = wc.send.bind(wc);
      (globalThis as any).__tokens = 0;
      wc.send = (channel: string, ...args: unknown[]) => {
        if (channel === "llama.rn:token") (globalThis as any).__tokens++;
        send(channel, ...args);
      };
    });
    await page.evaluate(() => {
      const w = window as any;
      w.__lengths = [];
      w.__sampler = setInterval(() => w.__lengths.push(document.body.innerText.length), 20);
    });

    await input.fill("What is a black hole?");
    await input.press("Enter");
    const sources = page.getByText("Retrieved sources");
    await sources.waitFor({ timeout: 5 * 60_000 });
    mark("answer done");
    const lengths: number[] = await page.evaluate(() => {
      const w = window as any;
      clearInterval(w.__sampler);
      return w.__lengths;
    });
    const tokens: number = await app.evaluate(() => (globalThis as any).__tokens);
    expect(tokens, "tokens streamed over IPC").toBeGreaterThan(1);
    expect(new Set(lengths).size, "page text grew in steps while the answer streamed").toBeGreaterThan(2);

    // The reply as the page shows it: between the question and its sources box.
    const body = await page.evaluate(() => document.body.innerText);
    const answerText = body.split("What is a black hole?")[1].split("Retrieved sources")[0].replace(/BOAR|📚/g, "").trim();
    expect(answerText.length).toBeGreaterThan(20);
    expect(answerText.toLowerCase()).toContain("black hole");
    // At least one citation chip (the source count badge is right after the title).
    await expect(page.getByText("Black hole", { exact: true }).first()).toBeVisible();
    const tokPerSec = await page.getByText(/tok\/s/).first().textContent().catch(() => null);
    mark(`answer: ${answerText.slice(0, 120)}… (${tokens} token events${tokPerSec ? `, header: ${tokPerSec}` : ""})`);
    await page.screenshot({ path: path.join(shots, "wave2-chat-answer.png") });
    // The answer's receipt: time and speed in its footer, tapped open for the details.
    const receipt = page.getByLabel("Performance details");
    await expect(receipt).toHaveText(/\d+\.\d s · \d+\.\d tok\/s/);
    await receipt.click();
    await expect(page.getByText(/^Total: /)).toBeVisible();
    await expect(page.getByText(/^Mode: /)).toBeVisible(); // the answer style first

    // ---- Alert.alert, one button: window.alert ---------------------------------------------------------
    await page.getByRole("button", { name: "You're online" }).click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatchObject({ type: "alert", message: expect.stringContaining("You're online") });

    // ---- Share.share: copies to the clipboard (code block's COPY / SHARE) ------------------------------
    await input.fill("Write a Python function that adds two numbers, in a code block.");
    await input.press("Enter");
    const copy = page.getByText("COPY / SHARE").first();
    await copy.waitFor({ timeout: 3 * 60_000 });
    await expect(input).toBeEditable({ timeout: 3 * 60_000 }); // answer finished
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await page.getByText("COPY / SHARE").first().click();
    await expect(page.getByText("✓ SHARED")).toBeVisible();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain("def ");
    await page.screenshot({ path: path.join(shots, "wave2-chat-code-copied.png") });

    // ---- Alert.alert with Cancel + destructive: window.confirm, OK runs the destructive onPress --------
    await openDrawer(page);
    await expect(page.getByText("Recent sessions")).toBeVisible();
    await page.getByText("Settings", { exact: true }).click();
    await page.getByText("Memory & Context Settings").click();
    await page.getByText("Clear All Chat History").click();
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[1]).toMatchObject({ type: "confirm", message: expect.stringContaining("Clear all chat history?") });
    await page.getByText("Done", { exact: true }).click();
    await openDrawer(page);
    await expect(page.getByText("New Research Session")).toBeVisible();
    await page.waitForTimeout(1500); // drawer slide-in / sidebar refresh + its session list load (it showed "Recent sessions" above)
    await expect(page.getByText("Recent sessions")).toHaveCount(0); // the confirm's onPress really cleared it
    await page.screenshot({ path: path.join(shots, "wave2-history-cleared.png") });

    expect(errors).toEqual([]);
  } catch (e) {
    await page?.screenshot({ path: path.join(shots, "wave2-failure.png") }).catch(() => {});
    throw e;
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true }); // removes the links, not the shared model files
  }
});
