/**
 * Settings ported from the native app: Show technical details (on by default; off hides the receipt's details, the
 * header's live speed, the menu's RAM/DISK and Hardware telemetry) and Reset settings (defaults back, models kept,
 * setup opens again).
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ask, completeSetup, launch, MODELS, modelsMissing, openDrawerItem, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

test("show technical details, then reset settings keeps the models", async () => {
  const userData = tempUserData();
  const s = await launch(userData);
  const { page } = s;
  try {
    await completeSetup(page, userData);
    await ask(page, "What is a black hole?");
    const receipt = page.getByLabel("Performance details");
    await expect(receipt).toHaveText(/\d+\.\d s · \d+\.\d tok\/s/, { timeout: 3 * 60_000 });
    await expect(page.getByText("RAM", { exact: true })).toBeVisible();

    // ---- the style button opens the style sheet: pick a style, switch Deep Research ----------------
    await page.getByLabel("Change how BOAR answers").click();
    await expect(page.getByText("Fastest — 2–3 brief paragraphs or bullets, no preamble.")).toBeVisible();
    await page.getByText("Executive Summary", { exact: true }).click();
    await expect(page.getByText("Fastest — 2–3 brief paragraphs or bullets, no preamble.")).toHaveCount(0);
    await page.getByLabel("Change how BOAR answers").click();
    await expect(page.getByRole("radio", { checked: true })).toContainText("Executive Summary");
    await page.getByRole("switch").last().click();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Deep Research Active").first()).toBeVisible();

    // ---- off: the short receipt stays, everything technical goes -----------------------------------
    await openDrawerItem(page, "Settings");
    await expect(page.getByText("Hardware Telemetry & Compliance", { exact: true })).toBeVisible();
    await page.getByText("Display & Theme", { exact: true }).click();
    await page.getByRole("switch").nth(1).click(); // haptics, then Show technical details
    await expect(page.getByText("Hardware Telemetry & Compliance", { exact: true })).toHaveCount(0);
    await page.getByText("Done", { exact: true }).click();
    await expect(receipt).toHaveCount(0);
    await expect(page.getByText(/\d+\.\d s · \d+\.\d tok\/s/)).toBeVisible();
    await expect(page.getByText("RAM", { exact: true })).toHaveCount(0);

    // ---- reset settings: confirm, setup opens, the models stay -------------------------------------
    await openDrawerItem(page, "Settings");
    await page.getByText("System Recovery & Danger Zone", { exact: true }).click();
    const before = s.dialogs.length;
    await page.getByText("Reset settings", { exact: true }).last().click();
    await expect.poll(() => s.dialogs.length).toBe(before + 1);
    expect(s.dialogs[before]).toMatchObject({ type: "confirm", message: expect.stringContaining("Reset all settings?") });
    await expect(page.getByText("Select Model Tier")).toBeVisible({ timeout: 60_000 });
    for (const f of MODELS) expect(fs.existsSync(path.join(userData, "documents/models", f))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(userData, "documents/settings.json"), "utf8"));
    expect(settings.showLiveStats).toBeUndefined();
    expect(settings.activeModelId.llm).toBeTruthy();
    expect(s.errors).toEqual([]);
  } finally {
    await s.app.close();
    rmUserData(userData);
  }
});
