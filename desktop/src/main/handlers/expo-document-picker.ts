import { BrowserWindow, dialog } from "electron";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HandlerContext } from "./context";

// MIME type -> extensions for the dialog filter: what the app asks for (documentImporter.ts). An unknown type, or
// "*/*", drops the filter.
const EXTENSIONS: Record<string, string[]> = {
  "text/plain": ["txt"],
  "text/markdown": ["md", "markdown"],
  "text/csv": ["csv"],
  "application/json": ["json"],
  "application/pdf": ["pdf"],
};
const MIME_OF: Record<string, string> = {};
for (const [mime, exts] of Object.entries(EXTENSIONS)) for (const e of exts) MIME_OF[e] = mime;

// "expo-document-picker": open dialog, then each file is copied to <cache>/DocumentPicker/<uuid>-<name> (the renderer
// may only read inside the app's folders). Flat, so deleting the copy (pickerCache.ts) leaves nothing behind; the
// original name travels in `name`. Same result shape as expo-document-picker.
export function register(ctx: HandlerContext): void {
  ctx.ipcMain.handle("expo-document-picker:getDocumentAsync", async (_e, opts: { type: string[]; multiple: boolean }) => {
    const types = opts.type;
    const known = types.every((t) => Object.hasOwn(EXTENSIONS, t));
    const extensions = types.flatMap((t) => (Object.hasOwn(EXTENSIONS, t) ? EXTENSIONS[t] : []));
    const dialogOpts: Electron.OpenDialogOptions = {
      properties: opts.multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: known && extensions.length ? [{ name: "Documents", extensions }] : undefined,
    };
    const wc = ctx.webContents();
    const win = wc ? BrowserWindow.fromWebContents(wc) : null;
    const r = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    if (r.canceled || r.filePaths.length === 0) return { canceled: true, assets: null };

    const assets = [];
    for (const src of r.filePaths) {
      const name = path.basename(src);
      const dest = path.join(ctx.roots.cache, "DocumentPicker", `${randomUUID()}-${name}`);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(src, dest);
      const s = await stat(dest);
      assets.push({
        uri: pathToFileURL(dest).href,
        name,
        size: s.size,
        mimeType: MIME_OF[path.extname(name).slice(1).toLowerCase()] ?? "application/octet-stream",
        lastModified: s.mtimeMs,
      });
    }
    return { canceled: false, assets };
  });
}
