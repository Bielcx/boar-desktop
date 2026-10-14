/**
 * Decides whether a download fits: within the bounty's 50GB total budget
 * for the app and all its offline assets, and within the phone's free
 * space. Pure, so it's testable; ModelManager supplies the measurements.
 */

import { formatBytes } from "./units";

/** Room kept for the app itself (APK, runtime files), which isn't measured on disk here. */
export const APP_RESERVE_BYTES = 1000 ** 3;
/** Free space to leave on the phone after a download. */
export const FREE_SPACE_MARGIN_BYTES = 500 * 1000 ** 2;

export interface StorageCheckInput {
  /** Bytes BOAR already uses on disk (models, knowledge base, database), excluding partial downloads. */
  usedBytes: number;
  /** Full sizes of other downloads still running or paused. */
  reservedBytes: number;
  /** Size of the file to download. */
  downloadBytes: number;
  /** Bytes of this file already on disk from a paused download. */
  alreadyDownloadedBytes: number;
  /** The phone's free space, or null if unknown. */
  freeDiskBytes: number | null;
  budgetBytes: number;
}

export type StorageCheck =
  | { ok: true; projectedBytes: number }
  | { ok: false; reason: "budget" | "disk"; projectedBytes: number; message: string };

const gb = (b: number) => formatBytes(b);

export function checkStorageForDownload(input: StorageCheckInput): StorageCheck {
  const projectedBytes = APP_RESERVE_BYTES + input.usedBytes + input.reservedBytes + input.downloadBytes;
  if (projectedBytes > input.budgetBytes) {
    return {
      ok: false,
      reason: "budget",
      projectedBytes,
      message:
        `Not enough room in BOAR's ${gb(input.budgetBytes)} storage budget: this ${gb(input.downloadBytes)} download ` +
        `would bring the total to about ${gb(projectedBytes)}. Remove a model first.`,
    };
  }
  const stillNeeded = Math.max(input.downloadBytes - input.alreadyDownloadedBytes, 0);
  if (input.freeDiskBytes !== null && stillNeeded + FREE_SPACE_MARGIN_BYTES > input.freeDiskBytes) {
    return {
      ok: false,
      reason: "disk",
      projectedBytes,
      message:
        `Not enough free space on this phone: the download needs ${gb(stillNeeded)} and only ` +
        `${gb(input.freeDiskBytes)} is free. Free up space or remove a model first.`,
    };
  }
  return { ok: true, projectedBytes };
}
