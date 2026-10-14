/**
 * The rest of the UI in the real window, after one setup: voice button (asks before downloading its model), stop generation,
 * every Settings section, removing a model (confirm, cancelled), language EN -> PT -> EN, Execution Telemetry and
 * its Evaluation screen (a short run, stopped), About and Prompt Ideas; the desktop layout (fixed sidebar when
 * wide, ☰ drawer when narrow), keyboard shortcuts and the native menu. No page or console errors throughout.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, chatInput, completeSetup, launch, MODELS, modelsMissing, openDrawerItem, rmUserData, setWindowSize, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

const SECTIONS = [
  "How BOAR answers",
  "Reasoning Models",
  "Offline Knowledge Base (RAG)",
  "Memory & Context Settings",
  "Hardware Telemetry & Compliance",
  "Display & Theme",
  "Language",
  "Voice Input Configuration",
  "Share my library (MCP)",
  "Watched folders (boar on duty)",
  "Local API server",
  "Security (PIN)",
  "System Recovery & Danger Zone",
];

test("voice, stop, settings, language, telemetry/evaluation, about", async ({}, testInfo) => {
  const shots = process.env.BOAR_E2E_SCREENSHOTS ?? testInfo.outputDir;
  fs.mkdirSync(shots, { recursive: true });
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `wave3-qa-${name}.png`) });
  const userData = tempUserData();
  const s = await launch(userData);
  const { page } = s;
  const lastDialog = async (n: number) => {
    await expect.poll(() => s.dialogs.length).toBe(n);
    return s.dialogs[n - 1];
  };
  try {
    await completeSetup(page, userData);

    // ---- voice: no whisper model yet -> asks before downloading it; Cancel downloads nothing (voice.spec.ts records) --
    s.dialogAnswer.accept = false;
    await page.getByText("🎤").click();
    expect(await lastDialog(1)).toMatchObject({ type: "confirm", message: expect.stringContaining("speech model") });
    s.dialogAnswer.accept = true;
    await expect(page.getByText("🎤")).toBeVisible();
    expect(fs.readdirSync(path.join(userData, "documents/models")).filter((f) => f.includes("whisper"))).toEqual([]);

    // ---- online/offline pill follows the network (NetInfo on web: navigator.onLine + events) ---------
    await expect(page.getByText("ONLINE", { exact: true })).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByText("OFFLINE", { exact: true })).toBeVisible({ timeout: 15_000 });
    await shot(page, "offline");
    await page.context().setOffline(false);
    await expect(page.getByText("ONLINE", { exact: true })).toBeVisible({ timeout: 15_000 });

    // ---- stop generation mid-answer -----------------------------------------------------------------
    await ask(page, "Write a detailed 800-word essay on the history of the Roman Empire.");
    const stop = page.getByLabel("Stop generation");
    await stop.waitFor({ timeout: 2 * 60_000 });
    await page.waitForFunction(() => document.body.innerText.includes("Roman"), null, { timeout: 2 * 60_000 });
    await page.waitForTimeout(1000);
    await stop.click();
    await expect(page.getByText("Stopped by user")).toBeVisible({ timeout: 60_000 });
    await expect(chatInput(page)).toBeEditable({ timeout: 60_000 });
    await shot(page, "stopped");

    // ---- desktop layout: fixed sidebar when wide, ☰ drawer (Esc closes it) when narrow -----------------
    const burger = page.getByLabel("Open Navigation Drawer");
    const newSession = page.getByText("New Research Session");
    const sidebarX = async () => (await newSession.boundingBox())!.x;
    expect(await sidebarX()).toBeGreaterThanOrEqual(0); // 1200 px default window: a fixed sidebar
    await burger.click(); // ☰ hides it and gives the chat the width
    await expect.poll(sidebarX).toBeLessThan(0);
    await burger.click();
    await expect.poll(sidebarX).toBeGreaterThanOrEqual(0);
    await setWindowSize(s.app, 820, 820);
    await expect(burger).toBeVisible();
    await expect.poll(sidebarX).toBeLessThan(0); // slid out of view
    await burger.click();
    await expect.poll(sidebarX).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect.poll(sidebarX).toBeLessThan(0);
    await setWindowSize(s.app, 1200, 820);
    await expect.poll(sidebarX).toBeGreaterThanOrEqual(0);

    // ---- keyboard: Esc stops the answer, Ctrl+K focuses the input, Ctrl+N starts a new chat ------------
    await ask(page, "Write a detailed 800-word essay on the history of the Ottoman Empire.");
    await stop.waitFor({ timeout: 2 * 60_000 });
    await page.keyboard.press("Escape"); // at once: a succinct answer can be done in 2 s on this GPU
    await expect(page.getByText("Stopped by user")).toHaveCount(2, { timeout: 60_000 });
    await expect(chatInput(page)).toBeEditable({ timeout: 60_000 });
    await page.getByText("Stopped by user").first().click(); // focus away from the input
    await expect(chatInput(page)).not.toBeFocused();
    await page.keyboard.press("Control+K");
    await expect(chatInput(page)).toBeFocused();
    await page.keyboard.press("Control+N"); // typed in the input: works there too
    await expect(page.getByText("Stopped by user")).toHaveCount(0);
    await expect(page.getByText("Try asking")).toBeVisible();
    await shot(page, "shortcut-new-chat");

    // ---- native menu: lists the shortcuts, and its items send them to the page ---------------------------
    const accelerators = await s.app.evaluate(({ Menu }) =>
      ["new-chat", "focus-input", "stop"].map((id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.accelerator)
    );
    expect(accelerators).toEqual(["CmdOrCtrl+N", "CmdOrCtrl+K", "Esc"]);
    const essay = page.getByText("Write a detailed 800-word essay on the history of the Ottoman Empire.", { exact: true });
    await expect(essay).toHaveCount(0);
    await page.getByText("just now").first().click(); // back to the stopped chat (the newest), from the sidebar
    await expect(essay).toBeVisible();
    await expect(chatInput(page)).not.toBeFocused();
    await s.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("focus-input")!.click());
    await expect(chatInput(page)).toBeFocused();
    await s.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("new-chat")!.click());
    await expect(page.getByText("Try asking")).toBeVisible();
    await expect(essay).toHaveCount(0);

    // ---- settings: open every section ---------------------------------------------------------------
    await openDrawerItem(page, "Settings");
    for (const title of SECTIONS) {
      await page.getByText(title, { exact: true }).first().click();
      await page.waitForTimeout(700);
      await shot(page, `settings-${title.replace(/\W+/g, "-").toLowerCase()}`);
      if (title === "Reasoning Models") {
        // Remove a model -> confirm; Cancel keeps the file.
        s.dialogAnswer.accept = false;
        await page.getByLabel("Delete model asset").first().click();
        const d = await lastDialog(2);
        expect(d.type).toBe("confirm");
        expect(d.message).toMatch(/Remove (Model Weights|Knowledge Base Pack|from list)\?/);
        s.dialogAnswer.accept = true;
        for (const f of MODELS) expect(fs.existsSync(path.join(userData, "documents/models", f))).toBe(true);
      }
      if (title === "Voice Input Configuration") {
        await expect(page.getByText("whisper.cpp on this computer (offline)")).toBeVisible();
        // Reading answers aloud is offered on desktop (Windows voices through main), off by default.
        await expect(page.getByText("Read answers aloud")).toBeVisible();
      }
      await page.getByText(title, { exact: true }).first().click(); // collapse again, keeps the next title on screen
    }

    // ---- language EN -> PT -> EN --------------------------------------------------------------------
    await page.getByText("Language", { exact: true }).click();
    await page.getByText("Português", { exact: true }).click();
    await expect(page.getByText("Configurações", { exact: true })).toBeVisible();
    await shot(page, "settings-pt");
    await page.getByText("English", { exact: true }).click();
    await expect(page.getByText("Settings", { exact: true })).toBeVisible();
    await page.getByText("Done", { exact: true }).click();

    // ---- execution telemetry + evaluation -----------------------------------------------------------
    await openDrawerItem(page, "Execution Telemetry");
    await expect(page.getByText(/[1-9]\d* recent runs?/)).toBeVisible(); // the stopped answer was recorded
    await page.getByText("🧪 Evaluate").click();
    await expect(page.getByText("Evaluation", { exact: true })).toBeVisible();
    await shot(page, "evaluation");
    await page.getByText("▶ Run").click();
    await page.getByText("■ Stop").click({ timeout: 60_000 });
    await expect(page.getByText("▶ Run")).toBeVisible({ timeout: 3 * 60_000 });
    await shot(page, "evaluation-stopped");
    await page.getByText("Done", { exact: true }).click();
    await page.getByText("Done", { exact: true }).click();

    // ---- about, prompt ideas ------------------------------------------------------------------------
    await openDrawerItem(page, "About & Info");
    await expect(page.getByText("About BOAR")).toBeVisible();
    await page.getByText("Done", { exact: true }).click();
    await openDrawerItem(page, "Prompt Ideas");
    await expect(page.getByText("Use This Research Prompt")).toBeVisible();
    await page.getByText("✕", { exact: true }).click();
    await expect(chatInput(page)).toBeEditable();

    expect(s.errors).toEqual([]);
  } catch (e) {
    await shot(page, "tour-failure").catch(() => {});
    throw e;
  } finally {
    fs.writeFileSync(path.join(shots, "wave3-qa-tour-log.txt"), [...s.errors, ...s.dialogs.map((d) => JSON.stringify(d))].join("\n"));
    await s.app.close();
    rmUserData(userData);
  }
});
