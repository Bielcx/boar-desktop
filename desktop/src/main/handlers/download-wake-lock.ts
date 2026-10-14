import { powerSaveBlocker } from "electron";
import type { HandlerContext } from "./context";

// "download-wake-lock": blocks system sleep (the screen may still turn off) while a download runs.
export function register(ctx: HandlerContext): void {
  let id: number | null = null;
  ctx.ipcMain.handle("download-wake-lock:acquire", () => {
    if (id === null || !powerSaveBlocker.isStarted(id)) id = powerSaveBlocker.start("prevent-app-suspension");
    return true;
  });
  ctx.ipcMain.handle("download-wake-lock:release", () => {
    if (id !== null) powerSaveBlocker.stop(id);
    id = null;
  });
}
