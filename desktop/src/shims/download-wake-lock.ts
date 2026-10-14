// Desktop shim for "download-wake-lock": keeps the computer from sleeping during a model download
// (Electron powerSaveBlocker, handlers/download-wake-lock.ts). The native API is sync; IPC isn't, so
// acquire reports true and the blocker starts a moment later.
import { native } from "../shared/bridge";

export function acquireDownloadWakeLock(): boolean {
  void native().invoke("download-wake-lock:acquire").catch(() => {});
  return true;
}

export function releaseDownloadWakeLock(): void {
  void native().invoke("download-wake-lock:release").catch(() => {});
}
