/**
 * Knowledge and Hugging Face on screens of their own (as the native app): the menu's Knowledge lists the topic packs
 * and the user's documents, Settings > Offline Knowledge Base links there, and Settings > Reasoning Models opens the
 * Hugging Face page with its size and sort filters. Offline, so nothing is asked of Hugging Face.
 */
import { expect, test } from "@playwright/test";
import { completeSetup, launch, modelsMissing, openDrawerItem, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

test("Knowledge lists packs and documents; Settings links there and opens the Hugging Face page", async () => {
  const userData = tempUserData();
  const s = await launch(userData);
  const { page } = s;
  try {
    await completeSetup(page, userData);

    await openDrawerItem(page, "Knowledge");
    await expect(page.getByText("Topic packs", { exact: true })).toBeVisible();
    await expect(page.getByText("Your documents", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Collection name (e.g. Project Specs)")).toBeVisible();
    await page.getByText("Done", { exact: true }).click();

    await openDrawerItem(page, "Settings");
    await page.getByText("Offline Knowledge Base (RAG)", { exact: true }).click();
    await page.getByText("Open Knowledge", { exact: true }).click();
    await expect(page.getByText("Topic packs", { exact: true })).toBeVisible();
    await page.getByText("Done", { exact: true }).click();

    // The page may reach Hugging Face's API (the CSP's connect-src); a CSP block reads as "Failed to fetch".
    const hf = await page.evaluate(() => fetch("https://huggingface.co/api/models?limit=1").then((r) => `status ${r.status}`, (e) => String(e)));
    expect(hf).toMatch(/^status /);

    await page.context().setOffline(true);
    await openDrawerItem(page, "Settings");
    await page.getByText("Reasoning Models", { exact: true }).click();
    await page.getByText("Browse Hugging Face models", { exact: true }).click();
    await expect(page.getByText("Hugging Face models", { exact: true })).toBeVisible();
    for (const chip of ["Any", "1–3B", "Trending", "Most downloaded", "Newest"]) await expect(page.getByText(chip, { exact: true })).toBeVisible();
    await page.getByText("Done", { exact: true }).last().click(); // the page's, over Settings' own
    await expect(page.getByText("Hugging Face models", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Browse Hugging Face models", { exact: true })).toBeVisible(); // Settings as it was
    expect(s.errors).toEqual([]);
  } finally {
    await s.app.close();
    rmUserData(userData);
  }
});
