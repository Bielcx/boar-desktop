/**
 * Personal documents on desktop: the document picker (Electron's open dialog, mocked from main) copies the file
 * into userData, the app indexes it with the real embedding model, and a question about its unique content is
 * answered with it as a source. Same for a PDF (text read by pdf.js in main); a password-protected PDF fails with
 * a clear message.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { lockedPdf, makePdf } from "../src/testing/pdf";
import { ask, chatInput, completeSetup, launch, mockOpenDialog, modelsMissing, openDrawerItem, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

test("import a .md note and a PDF, get both cited; locked PDF fails clearly; export and remove the collection", async ({}, testInfo) => {
  const shots = process.env.BOAR_E2E_SCREENSHOTS ?? testInfo.outputDir;
  fs.mkdirSync(shots, { recursive: true });
  const userData = tempUserData();
  const src = fs.mkdtempSync(path.join(path.dirname(userData), "boar-e2e-src-"));
  const note = path.join(src, "quokka-protocol.md");
  fs.writeFileSync(
    note,
    "# Quokka Protocol\n\nThe Quokka Protocol is the internal codename for the Vellmore greenhouse irrigation " +
      "schedule. Under the Quokka Protocol, the greenhouse is watered at 04:40 every morning with exactly 37 litres.\n"
  );
  const pdf = path.join(src, "beacon-log.pdf");
  fs.writeFileSync(pdf, makePdf(["Pell Island lighthouse log.", "The Zorblat beacon on Pell Island blinks exactly 11 times at dusk."]));
  const locked = path.join(src, "locked.pdf");
  fs.writeFileSync(locked, lockedPdf());

  const s = await launch(userData);
  const { app, page } = s;
  try {
    await completeSetup(page, userData);

    // ---- import the note and the PDF ------------------------------------------------------------------
    await openDrawerItem(page, "Knowledge");
    await page.getByPlaceholder("Collection name (e.g. Project Specs)").fill("Greenhouse notes");
    await mockOpenDialog(app, [note, pdf]);
    await page.getByText("Pick Files & Import").click();
    await expect(page.getByText("Greenhouse notes", { exact: true })).toBeVisible({ timeout: 2 * 60_000 });
    await expect(page.getByText(/2 docs\b/)).toBeVisible({ timeout: 2 * 60_000 });
    // The picker copied it to app-cache/DocumentPicker/<uuid>-<name>; the app deletes the copy after import
    // (pickerCache.ts), and nothing is left behind.
    expect(fs.readdirSync(path.join(userData, "app-cache/DocumentPicker"))).toEqual([]);
    await page.screenshot({ path: path.join(shots, "wave3-qa-doc-imported.png") });

    // ---- a password-protected PDF: Import failed, saying why -------------------------------------------
    await page.getByPlaceholder("Collection name (e.g. Project Specs)").fill("Scans");
    await mockOpenDialog(app, [locked]);
    await page.getByText("Pick Files & Import").click();
    await expect.poll(() => s.dialogs.length).toBe(1);
    expect(s.dialogs[0].type).toBe("alert");
    expect(s.dialogs[0].message).toContain("Import failed");
    expect(s.dialogs[0].message).toContain('"locked.pdf" is password-protected');
    await expect(page.getByText("Scans", { exact: true })).toHaveCount(0); // the failed collection was rolled back
    await page.getByText("Done", { exact: true }).click();

    // ---- ask about it -------------------------------------------------------------------------------
    await ask(page, "What is the Quokka Protocol and at what time is the greenhouse watered?");
    await page.getByText("Retrieved sources").waitFor({ timeout: 5 * 60_000 });
    await expect(chatInput(page)).toBeEditable({ timeout: 3 * 60_000 });
    await page.screenshot({ path: path.join(shots, "wave3-qa-doc-cited.png") });
    const body = await page.evaluate(() => document.body.innerText);
    const reply = body.split("Quokka Protocol and at what time")[1];
    expect(reply).toContain("04:40");
    expect(reply.split("Retrieved sources")[1]).toMatch(/quokka|Greenhouse notes/i);

    // ---- ask about the PDF ----------------------------------------------------------------------------
    await ask(page, "How many times does the Zorblat beacon on Pell Island blink at dusk?");
    await page.getByText("Retrieved sources").nth(1).waitFor({ timeout: 5 * 60_000 });
    await expect(chatInput(page)).toBeEditable({ timeout: 3 * 60_000 });
    await page.screenshot({ path: path.join(shots, "desktop-pdf-cited.png") });
    const pdfReply = (await page.evaluate(() => document.body.innerText)).split("blink at dusk?")[1];
    expect(pdfReply).toContain("11");
    expect(pdfReply.split("Retrieved sources")[1]).toContain("beacon-log");

    // ---- export (save dialog, mocked) and remove (confirm: Cancel keeps it, OK deletes) -------------------
    await openDrawerItem(page, "Knowledge");
    const exported = path.join(src, "exported.json");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
    }, exported);
    await page.getByText("Export / Share", { exact: false }).click();
    const readExport = () => {
      try {
        return fs.readFileSync(exported, "utf8");
      } catch {
        return ""; // not there yet, or still being written (EBUSY on Windows)
      }
    };
    await expect.poll(readExport).toContain("04:40");
    s.dialogAnswer.accept = false;
    await page.getByText("🗑️").click();
    await expect.poll(() => s.dialogs.length).toBe(2);
    expect(s.dialogs[1]).toMatchObject({ type: "confirm", message: expect.stringContaining("Remove this collection?") });
    await expect(page.getByText("Greenhouse notes", { exact: true })).toBeVisible();
    s.dialogAnswer.accept = true;
    await page.getByText("🗑️").click();
    await expect(page.getByText("No custom collections yet.")).toBeVisible();

    expect(s.errors).toEqual([]);
  } catch (e) {
    await page.screenshot({ path: path.join(shots, "wave3-qa-doc-failure.png") }).catch(() => {});
    throw e;
  } finally {
    await app.close();
    rmUserData(userData);
    fs.rmSync(src, { recursive: true, force: true });
  }
});
