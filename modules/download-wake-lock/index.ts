import { requireOptionalNativeModule } from "expo-modules-core";

interface DownloadWakeLockNativeModule {
  acquire(): boolean;
  release(): void;
}

// Optional: a JS bundle reloaded onto an older build without this module
// must keep downloading, just without the wake lock.
const native = requireOptionalNativeModule<DownloadWakeLockNativeModule>("DownloadWakeLock");

/**
 * Android: acquires the PARTIAL_WAKE_LOCK "BOAR:ModelDownload". iOS: disables
 * the idle timer and opens a background task. No-op if already held.
 */
export function acquireDownloadWakeLock(): boolean {
  return native?.acquire() ?? false;
}

/** Releases it. Safe to call when not held. */
export function releaseDownloadWakeLock(): void {
  native?.release();
}
