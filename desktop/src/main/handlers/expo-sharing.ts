import { app, BrowserWindow, dialog } from "electron";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { safePath } from "../storage/safePath";
import { fileRoots, type HandlerContext } from "./context";

// "expo-sharing": a save dialog that copies the app's file (inside its documents or cache folder) to where the user picks.
export function register(ctx: HandlerContext): void {
  ctx.ipcMain.handle("expo-sharing:shareAsync", async (_e, url: string, options: { dialogTitle?: string } = {}) => {
    const src = safePath(fileRoots(ctx), url);
    const wc = ctx.webContents();
    const win = wc ? BrowserWindow.fromWebContents(wc) : null;
    const opts = { title: options.dialogTitle, defaultPath: path.join(app.getPath("downloads"), path.basename(src)) };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (!r.canceled && r.filePath) await copyFile(src, r.filePath);
  });
}
