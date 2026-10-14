import * as FileSystem from "expo-file-system/legacy";
import * as BundledAssets from "bundled-assets";
import { networkAllowed } from "../config/variant";
import { checkStorageForDownload } from "./storageBudget";
import { copyWithSha256, measureFile, sha256OfFile, HashProgress } from "./fileHash";
import { AssetIntegrityError, candidatesBySize, digestsEqual, DownloadError, matchByDigest, throwIfAborted } from "./integrity";
import { allAssets } from "./assetRegistry";
import { checkImportSize, formatBytes, importKindOfAsset, MAX_ASSET_IMPORT_BYTES } from "./importLimits";
import {
  CatalogModel,
  MODEL_CATALOG,
  ANSWER_MODELS,
  STORAGE_BUDGET_BYTES,
} from "./manifest";

export interface AssetStatus {
  asset: CatalogModel;
  present: boolean;
  sizeOnDiskBytes: number;
  /** true = sha256 checked for this exact file; null = present, not hashed yet. */
  checksumOk: boolean | null;
  /** Bytes of an interrupted download kept on disk; the next download resumes from here. */
  partialBytes?: number;
  /**
   * An installed places tile that differs (size or sha256) from the current
   * tile index: kept and still searched; downloading again replaces it.
   */
  updateAvailable?: boolean;
}

/**
 * Places tiles (poi-t-*) are re-published by the tile index: a file that no
 * longer matches the index is the previous version of the area, not a broken
 * download, so it is kept (updateAvailable) instead of deleted. Only a tile
 * that fails to open is deleted (src/rag/pois.ts).
 */
export function keptAcrossIndexUpdates(asset: Pick<CatalogModel, "id" | "format">): boolean {
  return asset.format === "poi-pack" && asset.id.startsWith("poi-t-");
}

export interface DownloadProgress {
  /** "verifying" = sha256 of the finished file; bytes then count bytes hashed. */
  phase?: "downloading" | "verifying";
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
}

// How long a download can go with zero progress callbacks before it's
// treated as stalled and cancelled — see downloadCatalogModel's doc comment.
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60_000;

// console.log shows up in the Metro/dev-client terminal (not just on-device
// LogBox) — this is the debug trail for diagnosing the "0 bytes despite a
// clean-looking completion" reports without needing device log access.
// Progress is throttled (not one line per native callback, which would be
// thousands of lines for a multi-GB file) but every state TRANSITION
// (start, resume, timeout/pause, completion, verification result) is
// always logged, since those are the rare, high-signal moments.
const DOWNLOAD_PROGRESS_LOG_INTERVAL_MS = 5_000;
function dlog(assetId: string, message: string): void {
  console.log(`[ModelManager:download:${assetId}] ${message}`);
}

// Module-level, not per-instance: many screens each construct their own
// ModelManager, and any of them calling statusOf() mid-download must see
// this. Holds ids of downloads that are running OR paused-for-resume —
// their on-disk file is legitimately partial and must not be deleted as
// "truncated". (Deleting it doesn't stop the native writer on Android —
// it keeps writing to the unlinked inode, resolves 200, and the path is
// simply gone at verification time.)
const downloadsOwningFile = new Map<string, CatalogModel>();
const progressHooks = new Map<string, (data: FileSystem.DownloadProgressData) => void>();

// Everything BOAR stores that counts toward the 50GB budget.
const STORAGE_DIRS = ["models/", "corpus/", "poi/", "SQLite/"];

/** Bytes used by BOAR's offline assets, not counting the partial files of the given paths. */
async function measureUsedBytes(excludePaths: Set<string>): Promise<number> {
  let total = 0;
  for (const dir of STORAGE_DIRS) {
    const dirPath = `${FileSystem.documentDirectory}${dir}`;
    const names = await FileSystem.readDirectoryAsync(dirPath).catch(() => [] as string[]);
    for (const name of names) {
      const path = `${dirPath}${name}`;
      if (excludePaths.has(path)) continue;
      const info = await FileSystem.getInfoAsync(path).catch(() => null);
      if (info?.exists && !info.isDirectory) total += info.size ?? 0;
    }
  }
  return total;
}

function assetPath(asset: Pick<CatalogModel, "filename">): string {
  return `${FileSystem.documentDirectory}${asset.filename}`;
}

/**
 * Files whose sha256 was checked on this device, keyed by filename, with the
 * size and mtime they had then. A file that changed since doesn't count.
 * Lets the UI show "verified" without re-hashing gigabytes on every launch.
 */
type VerifiedRecord = { size: number; mtime: number; sha256: string };
const VERIFIED_PATH = () => `${FileSystem.documentDirectory}integrity.json`;
let verifiedCache: Record<string, VerifiedRecord> | null = null;

async function loadVerified(): Promise<Record<string, VerifiedRecord>> {
  if (verifiedCache) return verifiedCache;
  try {
    verifiedCache = JSON.parse(await FileSystem.readAsStringAsync(VERIFIED_PATH())) ?? {};
  } catch {
    verifiedCache = {};
  }
  return verifiedCache!;
}

async function recordVerified(asset: CatalogModel): Promise<void> {
  const info = await FileSystem.getInfoAsync(assetPath(asset));
  if (!info.exists) return;
  const records = await loadVerified();
  records[asset.filename] = { size: info.size ?? 0, mtime: info.modificationTime ?? 0, sha256: asset.sha256 };
  await FileSystem.writeAsStringAsync(VERIFIED_PATH(), JSON.stringify(records)).catch(() => {});
}

/**
 * Multi-GB models must not go to iCloud/device backup (App Store rule).
 * excludeFromBackup lands in bundled-assets with the iOS work; until then,
 * and on Android where it's a no-op, this does nothing.
 */
async function excludeFromBackup(path: string): Promise<void> {
  const fn = (BundledAssets as { excludeFromBackup?: (p: string) => unknown }).excludeFromBackup;
  try {
    await fn?.(path);
  } catch (e: any) {
    console.warn("[ModelManager] excludeFromBackup failed:", e?.message ?? e);
  }
}

async function forgetVerified(asset: Pick<CatalogModel, "filename">): Promise<void> {
  const records = await loadVerified();
  if (!(asset.filename in records)) return;
  delete records[asset.filename];
  await FileSystem.writeAsStringAsync(VERIFIED_PATH(), JSON.stringify(records)).catch(() => {});
}

/** "Erase everything": forget every verified file, on disk and in memory (the files themselves are deleted too). */
export async function clearVerifiedRecords(): Promise<void> {
  verifiedCache = {};
  await FileSystem.deleteAsync(VERIFIED_PATH(), { idempotent: true });
}

/** For tests: drop the in-memory copy of integrity.json. */
export function resetVerifiedCacheForTests(): void {
  verifiedCache = null;
}

/**
 * Local file manager for model weights. Two ways an asset ends up on disk:
 *
 * 1. **Downloaded** (`downloadCatalogModel`): fetches a catalog entry over
 *    the network — used for both the required default models (via the
 *    mandatory first-run ModelSetupScreen) and optional extras (via the
 *    same screen's normal mode). Always an explicit user action; never
 *    automatic, never during chat/inference.
 * 2. **Bundled** (`installBundled`): copies a model baked into the APK's
 *    compiled assets (via the `bundled-assets` native module +
 *    plugins/withBundledModels.js) into the document directory, purely
 *    locally. Not used by default (keeps the installable app small/fast to
 *    build) but available as an alternate build path — see manifest.ts.
 */
export class ModelManager {
  /**
   * `catalog` is what statusAll() reports on. File imports match against
   * the whole asset registry (catalog + places packs + gazetteer + ...)
   * unless this instance was given an explicit catalog (tests, tools).
   */
  constructor(private catalog: CatalogModel[] = MODEL_CATALOG) {
    this.explicitCatalog = catalog !== MODEL_CATALOG;
  }

  private explicitCatalog: boolean;

  private importCatalog(): CatalogModel[] {
    return this.explicitCatalog ? this.catalog : allAssets();
  }

  /**
   * Paused-but-resumable downloads, keyed by asset id. expo-file-system's
   * own docs: "When the app has been moved to the background, this
   * [progress] callback won't be fired until it's moved to the foreground"
   * — so backgrounding looks identical to a truly stalled connection from
   * downloadCatalogModel's inactivity timer's point of view, and the timer
   * correctly fires. The fix isn't to stop detecting that (a genuinely dead
   * connection should still surface an error) — it's to make what happens
   * next cheap: pause (keep the partial bytes + resume token) instead of
   * cancel-and-delete, so a retry continues from here instead of
   * restarting a multi-GB download from 0%.
   */
  private pausedDownloads = new Map<string, FileSystem.DownloadResumable>();

  /**
   * A file that exists but doesn't match the catalog's expected size is
   * treated as NOT present (and cleaned up) rather than a false "present" —
   * this is what an interrupted/truncated download looks like (e.g. the
   * app backgrounded or network dropped mid-transfer), and llama.cpp fails
   * to load such a file with a generic, unhelpful error. Catching this here
   * means the UI correctly offers "Download"/"Retry" instead of showing a
   * green "Downloaded" badge for a file that will fail the moment it's used.
   */
  async statusOf(asset: CatalogModel): Promise<AssetStatus> {
    const path = assetPath(asset);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) {
      return { asset, present: false, sizeOnDiskBytes: 0, checksumOk: null };
    }
    const sizeOnDisk = info.size ?? 0;
    if (keptAcrossIndexUpdates(asset) && !downloadsOwningFile.has(asset.id)) {
      const record = (await loadVerified())[asset.filename];
      const installed = !!record && record.size === sizeOnDisk && record.mtime === (info.modificationTime ?? 0);
      // A verified earlier version, or an unverified file too big to be a partial download of this one.
      if ((installed && (sizeOnDisk !== asset.sizeBytes || !digestsEqual(record.sha256, asset.sha256))) || (!installed && sizeOnDisk > asset.sizeBytes)) {
        return { asset, present: true, sizeOnDiskBytes: sizeOnDisk, checksumOk: installed ? true : null, updateAvailable: true };
      }
    }
    if (sizeOnDisk !== asset.sizeBytes) {
      // Smaller = an interrupted download: keep it, the next download resumes
      // from its last byte (Range request) and the sha256 check at the end
      // still guards the result. Larger can't be a prefix of the right file.
      if (downloadsOwningFile.has(asset.id) || sizeOnDisk < asset.sizeBytes) {
        return { asset, present: false, sizeOnDiskBytes: 0, checksumOk: null, partialBytes: sizeOnDisk };
      }
      dlog(asset.id, `statusOf(): deleting oversized file (${sizeOnDisk} > ${asset.sizeBytes})`);
      await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
      return { asset, present: false, sizeOnDiskBytes: 0, checksumOk: null };
    }
    const record = (await loadVerified())[asset.filename];
    const verified =
      !!record &&
      record.size === sizeOnDisk &&
      record.mtime === (info.modificationTime ?? 0) &&
      digestsEqual(record.sha256, asset.sha256);
    return {
      asset,
      present: true,
      sizeOnDiskBytes: sizeOnDisk,
      checksumOk: verified ? true : null,
    };
  }

  async statusAll(): Promise<AssetStatus[]> {
    return Promise.all(this.catalog.map((a) => this.statusOf(a)));
  }

  /**
   * Streaming sha256 of the installed file (native, chunked: memory stays
   * flat even for multi-GB models) compared against the catalog. A match is
   * remembered in integrity.json so statusOf() reports checksumOk: true.
   */
  async verifyChecksum(asset: CatalogModel, onProgress?: HashProgress): Promise<boolean> {
    // Hugging Face search results without LFS metadata have no known hash:
    // size is all we can check, and deleting them here would make them
    // impossible to install.
    if (!asset.sha256) return true;
    const digest = await sha256OfFile(assetPath(asset), onProgress);
    const ok = digestsEqual(asset.sha256, digest);
    if (ok) await recordVerified(asset);
    else await forgetVerified(asset);
    dlog(asset.id, `sha256 ${ok ? "ok" : `MISMATCH: got ${digest}, expected ${asset.sha256}`}`);
    return ok;
  }

  /** A stalled download, left paused for the next attempt to resume. */
  private async pausedError(asset: CatalogModel, destPath: string): Promise<DownloadError> {
    const stallS = DOWNLOAD_INACTIVITY_TIMEOUT_MS / 1000;
    const kept = (await FileSystem.getInfoAsync(destPath).catch(() => null)) as { exists: boolean; size?: number } | null;
    return new DownloadError(
      { code: "paused", bytesDone: kept?.exists ? kept.size ?? 0 : 0, bytesTotal: asset.sizeBytes, stallS },
      `Download of ${asset.label} paused (no progress for ${stallS}s) — tap Retry to resume, or check your connection.`
    );
  }

  /**
   * Installs an asset from a file the user picked (SAF / document picker),
   * with no network. The file is identified by content, not name: its size
   * narrows the catalog, then its sha256 (computed while copying, in one
   * pass) must match exactly one entry. Anything else is deleted and
   * rejected. Aborting `signal` stops the copy/hash, deletes the partial copy
   * and rejects with ImportAbortedError (name "AbortError"). Returns the
   * catalog entry that was installed.
   */
  async importFromFile(
    srcUri: string,
    onProgress?: HashProgress,
    signal?: AbortSignal,
    catalog: CatalogModel[] = this.importCatalog()
  ): Promise<CatalogModel> {
    // Every attempt and every refusal is logged, including the ones decided
    // before any copy (unknown size, too large, no room): a silent refusal
    // looks like "the import button does nothing" on a device.
    dlog("import", `importing ${srcUri}`);
    try {
      return await this.importFromFileUnlogged(srcUri, onProgress, signal, catalog);
    } catch (e: any) {
      const kind = e instanceof AssetIntegrityError ? e.kind : e?.name ?? "error";
      dlog("import", `refused ${srcUri}: ${kind}: ${e?.message ?? e}`);
      throw e;
    }
  }

  private async importFromFileUnlogged(
    srcUri: string,
    onProgress: HashProgress | undefined,
    signal: AbortSignal | undefined,
    catalog: CatalogModel[]
  ): Promise<CatalogModel> {
    // Entries without a known hash can't be identified by content.
    catalog = catalog.filter((a) => /^[0-9a-f]{64}$/i.test(a.sha256));
    throwIfAborted(signal);
    // Not getInfoAsync: it measured a content:// file over 2 GB as 0 bytes (IMP-2GB).
    const measured = await measureFile(srcUri);
    if (measured.kind === "empty") {
      throw new AssetIntegrityError("empty-file", "The selected file is empty (0 bytes). Copy it to the phone again.", true);
    }
    if (measured.kind === "unreadable") {
      throw new AssetIntegrityError("unreadable-file", "The selected file could not be read.", true);
    }
    const size = measured.bytes;
    // Before anything is copied: nothing installable is this big.
    if (size > MAX_ASSET_IMPORT_BYTES) {
      throw new AssetIntegrityError(
        "too-large",
        `This file is ${formatBytes(size)}; nothing BOAR can install is larger than ${formatBytes(MAX_ASSET_IMPORT_BYTES)}.`,
        true
      );
    }
    const candidates = candidatesBySize(catalog, size).filter((a) => checkImportSize(importKindOfAsset(a), size).ok);
    if (candidates.length === 0) {
      throw new AssetIntegrityError(
        "unknown-file",
        `This file (${size} bytes) is not a model or pack BOAR knows. Pick the exact file from the offline install list.`,
        true
      );
    }

    const others = [...downloadsOwningFile.values()];
    const storage = checkStorageForDownload({
      usedBytes: await measureUsedBytes(new Set(others.map(assetPath))),
      reservedBytes: others.reduce((sum, m) => sum + m.sizeBytes, 0),
      downloadBytes: size,
      alreadyDownloadedBytes: 0,
      freeDiskBytes: await FileSystem.getFreeDiskStorageAsync().catch(() => null),
      budgetBytes: STORAGE_BUDGET_BYTES,
    });
    if (!storage.ok) throw new AssetIntegrityError("storage", storage.message, true);

    const tmpDir = `${FileSystem.documentDirectory}imports/`;
    await FileSystem.makeDirectoryAsync(tmpDir, { intermediates: true }).catch(() => {});
    const tmpPath = `${tmpDir}import-${Date.now()}.part`;
    try {
      const { sha256, bytes } = await copyWithSha256(srcUri, tmpPath, onProgress, signal);
      throwIfAborted(signal);
      const match = matchByDigest(candidates, bytes, sha256);
      if (!match) {
        throw new AssetIntegrityError(
          "hash-mismatch",
          `The file's SHA-256 (${sha256}) does not match any catalog entry of that size. It may be corrupt or a different build of the model.`,
          true
        );
      }
      const dest = assetPath(match);
      await FileSystem.makeDirectoryAsync(dest.substring(0, dest.lastIndexOf("/")), { intermediates: true }).catch(() => {});
      await FileSystem.deleteAsync(dest, { idempotent: true });
      await FileSystem.moveAsync({ from: tmpPath, to: dest });
      await recordVerified(match);
      await excludeFromBackup(dest);
      dlog(match.id, `imported from ${srcUri}, sha256 ok`);
      return match;
    } finally {
      await FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
    }
  }

  /**
   * Installs a bundled model from the APK's compiled assets into the
   * document directory, if not already present with the right size. No
   * network access. Idempotent — safe to call on every launch.
   */
  async installBundled(asset: CatalogModel): Promise<void> {
    const status = await this.statusOf(asset);
    if (status.present && status.sizeOnDiskBytes === asset.sizeBytes) return;

    const assetSubPath = `models/${asset.filename.split("/").pop()}`;
    const destPath = assetPath(asset);
    const writtenBytes = await BundledAssets.copyBundledAssetToFile(assetSubPath, destPath);

    if (writtenBytes !== asset.sizeBytes) {
      throw new Error(
        `Bundled asset ${asset.id} size mismatch after copy: expected ${asset.sizeBytes}, got ${writtenBytes}`
      );
    }
  }

  async installAllBundled(): Promise<void> {
    const bundled = this.catalog.filter((m) => m.bundled);
    for (const asset of bundled) {
      await this.installBundled(asset);
    }
  }

  /**
   * Escape hatch for a download that's stuck with no error at all — no
   * progress, no failure, `pausedDownloads` possibly holding a resumable
   * whose underlying transfer nothing is actually driving forward anymore
   * (e.g. a stale reference left over from a dev Fast Refresh mid-download,
   * or a native task that silently stopped calling back). Unlike the
   * timeout/backgrounding path, this doesn't wait for anything to detect
   * the stall — it's user-triggered.
   *
   * Split into two steps (signal, then delete) rather than one, because
   * `pauseAsync()` resolving only means cancellation was *requested* — the
   * native write loop notices `isPausing` and stops on its next iteration,
   * which is asynchronous and not awaited by pause() itself. Deleting the
   * file and starting a new download immediately after signalling cancel
   * (as an earlier version of this method did) raced the old, now-orphaned
   * writer: if its stream happened to close *after* the new download
   * finished, it silently truncated the file right back down — the new
   * download would verify as `0 bytes` despite having fully completed.
   * Callers MUST await the corresponding downloadCatalogModel() promise's
   * settlement between calling signalCancelDownload and
   * deletePartialDownload (see downloadManager.restartDownload) so the old
   * writer is actually gone before the file is touched again.
   */
  async signalCancelDownload(asset: CatalogModel): Promise<void> {
    const active = this.pausedDownloads.get(asset.id);
    dlog(asset.id, `signalCancelDownload() called, had a tracked resumable: ${!!active}`);
    if (active) {
      await active.pauseAsync().catch(() => {});
      this.pausedDownloads.delete(asset.id);
    }
  }

  async deletePartialDownload(asset: CatalogModel): Promise<void> {
    dlog(asset.id, "deletePartialDownload() called");
    downloadsOwningFile.delete(asset.id);
    await FileSystem.deleteAsync(assetPath(asset), { idempotent: true }).catch(() => {});
  }

  /**
   * Downloads an optional (non-bundled) catalog model. Network access
   * happens ONLY here, and only when explicitly invoked (a user tap in
   * ModelSetupScreen) — never automatically and never during chat/inference.
   * Verifies the downloaded size matches the catalog entry; deletes and
   * throws on mismatch rather than leaving a truncated/corrupt file.
   */
  async downloadCatalogModel(
    asset: CatalogModel,
    onProgress?: (p: DownloadProgress) => void
  ): Promise<void> {
    if (!asset.sourceUrl) {
      throw new AssetIntegrityError(
        "no-source",
        `${asset.label} isn't available for download yet. Import the file instead (see the offline install list).`,
        true
      );
    }
    if (!networkAllowed()) {
      throw new AssetIntegrityError(
        "offline-variant",
        "This build of BOAR has no network permission. Import the file instead (see the offline install list).",
        true
      );
    }
    const destPath = assetPath(asset);
    const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
    await FileSystem.makeDirectoryAsync(destDir, { intermediates: true }).catch(() => {});

    // Refuse before any network request if it wouldn't fit.
    const others = [...downloadsOwningFile.values()].filter((m) => m.id !== asset.id);
    const partial = await FileSystem.getInfoAsync(destPath).catch(() => null);
    const storage = checkStorageForDownload({
      usedBytes: await measureUsedBytes(new Set([destPath, ...others.map(assetPath)])),
      reservedBytes: others.reduce((sum, m) => sum + m.sizeBytes, 0),
      downloadBytes: asset.sizeBytes,
      alreadyDownloadedBytes: partial?.exists ? partial.size ?? 0 : 0,
      freeDiskBytes: await FileSystem.getFreeDiskStorageAsync().catch(() => null),
      budgetBytes: STORAGE_BUDGET_BYTES,
    });
    dlog(asset.id, `storage check: ${storage.ok ? "ok" : storage.reason}, projected ${storage.projectedBytes} of ${STORAGE_BUDGET_BYTES} bytes`);
    if (!storage.ok) throw new AssetIntegrityError("storage", storage.message, true);

    // A file left by an interrupted download (network drop, app killed,
    // restart) is the resume point: its length goes out as `Range: bytes=N-`.
    const pausedResumable = this.pausedDownloads.get(asset.id);
    let resumeFrom = 0;
    // The previous version of a places tile is not a partial of this one: start over instead of resuming onto it.
    if (!pausedResumable && partial?.exists && keptAcrossIndexUpdates(asset) && (await this.statusOf(asset)).updateAvailable) {
      dlog(asset.id, "previous version of the tile on disk — replacing it");
      await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
      await forgetVerified(asset);
    } else if (!pausedResumable && partial?.exists) {
      const size = partial.size ?? 0;
      if (size === asset.sizeBytes) {
        dlog(asset.id, "complete file already on disk — verifying instead of downloading");
        await this.verifyDownloaded(asset, onProgress);
        return;
      }
      if (size > asset.sizeBytes) await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
      else resumeFrom = size;
    }

    downloadsOwningFile.set(asset.id, asset);

    const freeBytesAtStart = await FileSystem.getFreeDiskStorageAsync().catch(() => -1);
    dlog(
      asset.id,
      `start — expected ${asset.sizeBytes} bytes, destPath=${destPath}, ` +
        `alreadyHasPausedResumable=${this.pausedDownloads.has(asset.id)}, sourceUrl=${asset.sourceUrl}, ` +
        `freeDiskStorage=${freeBytesAtStart}`
    );

    // Inactivity timeout, not a flat deadline: a large model on a slow-but-
    // working connection can legitimately take many minutes, but zero
    // progress callbacks for this long means something stopped it —
    // either a genuinely dead connection, OR the app was backgrounded
    // (expo-file-system: progress callbacks "won't be fired until moved to
    // foreground"). Both look identical from here, so both are handled the
    // same way: pause (keep the partial file + resume token), not
    // cancel-and-delete. A subsequent call for the same asset — the Retry
    // button, or the auto-resume-on-foreground in SetupWizardScreen —
    // reuses the paused resumable and continues from where it left off
    // instead of restarting a multi-GB download from 0%.
    let timedOut = false;
    // Set when the server announces a different size than the catalog: the
    // pinned file is gone or replaced, so downloading it would only fail
    // verification minutes (or gigabytes) later. Stop at the first callback.
    let serverSize: number | null = null;
    // Set when a resumed request's total doesn't add up: the server ignored
    // the Range header and is sending the whole file, which would be appended
    // after the partial bytes. Throw the partial away and start over.
    let rangeIgnored = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let downloadResumable: FileSystem.DownloadResumable;
    let lastProgressLogAt = 0;
    let progressCallbackCount = 0;
    const resetInactivityTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        dlog(asset.id, `INACTIVITY TIMEOUT after ${DOWNLOAD_INACTIVITY_TIMEOUT_MS}ms with no progress callback — pausing`);
        downloadResumable.pauseAsync().catch(() => {});
      }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
    };

    const resuming = pausedResumable ?? null;
    const isResume = !!resuming || resumeFrom > 0;
    dlog(
      asset.id,
      resuming
        ? "resuming from a previously paused DownloadResumable"
        : resumeFrom > 0
          ? `resuming an interrupted download from byte ${resumeFrom}`
          : "starting a fresh downloadAsync()"
    );
    // The native progress callback is bound once, when the resumable is
    // created, but each call (fresh or resume) has its own inactivity timer
    // and onProgress. Route through progressHooks so a resumed transfer
    // resets THIS call's timer instead of the finished call's one (which
    // left the resumed call pausing itself every 60s despite progress).
    const onData = (data: FileSystem.DownloadProgressData) => {
      resetInactivityTimer();
      // First callback of this request: the native side reports the full
      // expected size (already-downloaded bytes + this response's length).
      if (
        serverSize === null &&
        !rangeIgnored &&
        progressCallbackCount === 0 &&
        data.totalBytesExpectedToWrite > 0 &&
        data.totalBytesExpectedToWrite !== asset.sizeBytes
      ) {
        if (isResume) rangeIgnored = true;
        else serverSize = data.totalBytesExpectedToWrite;
        dlog(
          asset.id,
          `server total ${data.totalBytesExpectedToWrite} != catalog ${asset.sizeBytes} — ` +
            (isResume ? "Range ignored, restarting from zero" : "aborting")
        );
        downloadResumable.pauseAsync().catch(() => {});
        return;
      }
      progressCallbackCount++;
      const now = Date.now();
      if (now - lastProgressLogAt >= DOWNLOAD_PROGRESS_LOG_INTERVAL_MS) {
        lastProgressLogAt = now;
        const pct = data.totalBytesExpectedToWrite > 0
          ? ((data.totalBytesWritten / data.totalBytesExpectedToWrite) * 100).toFixed(1)
          : "?";
        dlog(asset.id, `progress: ${data.totalBytesWritten}/${data.totalBytesExpectedToWrite} bytes (${pct}%), callback #${progressCallbackCount}`);
      }
      onProgress?.({
        phase: "downloading",
        totalBytesWritten: data.totalBytesWritten,
        totalBytesExpectedToWrite: data.totalBytesExpectedToWrite,
      });
    };
    progressHooks.set(asset.id, onData);
    downloadResumable =
      resuming ??
      FileSystem.createDownloadResumable(
        asset.sourceUrl,
        destPath,
        {},
        (data) => progressHooks.get(asset.id)?.(data),
        resumeFrom > 0 ? String(resumeFrom) : undefined
      );
    this.pausedDownloads.set(asset.id, downloadResumable);
    resetInactivityTimer();

    let result: FileSystem.FileSystemDownloadResult | undefined;
    try {
      result = await (isResume ? downloadResumable.resumeAsync() : downloadResumable.downloadAsync());
      dlog(
        asset.id,
        `${isResume ? "resumeAsync" : "downloadAsync"}() resolved — ` +
          `result=${result ? `{uri: ${result.uri}, status: ${result.status}}` : "undefined"}, ` +
          `total progress callbacks received: ${progressCallbackCount}`
      );
    } catch (e: any) {
      clearTimeout(timer);
      dlog(asset.id, `${isResume ? "resumeAsync" : "downloadAsync"}() THREW: ${e?.message ?? e} (timedOut=${timedOut})`);
      if (serverSize !== null) await this.abandonDownload(asset);
      if (serverSize !== null) throw sizeChangedError(asset, serverSize);
      if (rangeIgnored) await this.abandonDownload(asset);
      if (rangeIgnored) throw rangeIgnoredError(asset);
      if (timedOut) {
        // Paused, not deleted — stays in pausedDownloads for the next call
        // to pick up. Only genuinely-failed (non-timeout) downloads below
        // are treated as unrecoverable and cleaned up.
        throw await this.pausedError(asset, destPath);
      }
      // A dropped connection (or any other transfer error): keep the bytes we
      // have. The next attempt resumes from the file's length, and the
      // sha256 check at the end catches anything that went wrong.
      progressHooks.delete(asset.id);
      this.pausedDownloads.delete(asset.id);
      downloadsOwningFile.delete(asset.id);
      const kept = (await FileSystem.getInfoAsync(destPath).catch(() => null)) as { exists: boolean; size?: number } | null;
      const keptBytes = kept?.exists ? kept.size ?? 0 : 0;
      // The exception text went to the log above; the UI gets a code and numbers.
      throw new DownloadError(
        { code: "interrupted", bytesDone: keptBytes, bytesTotal: asset.sizeBytes },
        `Download of ${asset.label} was interrupted at ${keptBytes} of ${asset.sizeBytes} bytes. Retry to continue from there.`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!result && serverSize !== null) {
      await this.abandonDownload(asset);
      throw sizeChangedError(asset, serverSize);
    }
    if (!result && rangeIgnored) {
      await this.abandonDownload(asset);
      throw rangeIgnoredError(asset);
    }

    if (!result) {
      // resolves to undefined on pause too, not just cancel — same
      // stalled/paused case as the throw path above, just via the resolve
      // side of the promise instead of a rejection.
      dlog(asset.id, "result was undefined (pause/cancel) — leaving paused for next attempt to resume");
      throw await this.pausedError(asset, destPath);
    }

    progressHooks.delete(asset.id);
    this.pausedDownloads.delete(asset.id);
    downloadsOwningFile.delete(asset.id);

    const info = await FileSystem.getInfoAsync(destPath);
    const freeBytesAtEnd = await FileSystem.getFreeDiskStorageAsync().catch(() => -1);
    dlog(
      asset.id,
      `post-download verification: info.exists=${info.exists}, info.size=${info.exists ? info.size : "n/a"}, ` +
        `expected=${asset.sizeBytes}, freeDiskStorage=${freeBytesAtEnd} (was ${freeBytesAtStart} at start)`
    );
    if (!info.exists || info.size !== asset.sizeBytes) {
      const actualSize = info.exists ? info.size ?? 0 : 0;
      // A multi-hundred-MB+ GGUF landing at a few KB almost always means the
      // "download" actually succeeded at the HTTP level but the body wasn't
      // the model — e.g. a rate-limit/error page served with a 200 status,
      // which a plain byte-count check alone can't distinguish from a truly
      // corrupt transfer. Surfacing the actual size (and a text snippet when
      // it's small enough to plausibly be one of those pages) turns "size
      // mismatch" from a dead end into an actionable signal instead of
      // silently deleting the only evidence of what really happened.
      let snippet = "";
      if (actualSize > 0 && actualSize < 65536) {
        try {
          const text = await FileSystem.readAsStringAsync(destPath, {
            encoding: FileSystem.EncodingType.UTF8,
          });
          snippet = ` Response body: ${text.slice(0, 300)}`;
        } catch {
          // Not decodable as UTF8 (genuinely partial binary) — no snippet, still report sizes.
        }
      }
      await FileSystem.deleteAsync(destPath, { idempotent: true });
      throw new AssetIntegrityError(
        "size-mismatch",
        `Download of ${asset.label} failed verification — got ${actualSize} bytes, expected ${asset.sizeBytes}.${snippet}`,
        false
      );
    }

    await this.verifyDownloaded(asset, onProgress);
  }

  /** sha256 of a complete downloaded file; deletes it and throws permanently on mismatch. */
  private async verifyDownloaded(asset: CatalogModel, onProgress?: (p: DownloadProgress) => void): Promise<void> {
    const destPath = assetPath(asset);
    await excludeFromBackup(destPath);
    if (!asset.sha256) return;
    onProgress?.({ phase: "verifying", totalBytesWritten: 0, totalBytesExpectedToWrite: asset.sizeBytes });
    const ok = await this.verifyChecksum(asset, (done, total) =>
      onProgress?.({ phase: "verifying", totalBytesWritten: done, totalBytesExpectedToWrite: total > 0 ? total : asset.sizeBytes })
    );
    if (!ok) {
      await FileSystem.deleteAsync(destPath, { idempotent: true });
      throw new AssetIntegrityError(
        "hash-mismatch",
        `Download of ${asset.label} has the right size but the wrong SHA-256, so it was deleted. The source may have been tampered with; import a verified copy instead.`,
        true
      );
    }
  }

  private async abandonDownload(asset: CatalogModel): Promise<void> {
    progressHooks.delete(asset.id);
    this.pausedDownloads.delete(asset.id);
    downloadsOwningFile.delete(asset.id);
    await FileSystem.deleteAsync(assetPath(asset), { idempotent: true }).catch(() => {});
  }

  async deleteModel(asset: CatalogModel): Promise<void> {
    await FileSystem.deleteAsync(assetPath(asset), { idempotent: true });
    await forgetVerified(asset);
  }

  async currentStorageUsageBytes(): Promise<number> {
    const statuses = await this.statusAll();
    return statuses.reduce((sum, s) => sum + s.sizeOnDiskBytes, 0);
  }


  missingAssets(statuses: AssetStatus[]): CatalogModel[] {
    return statuses.filter((s) => !s.present).map((s) => s.asset);
  }

  /**
   * Whether setup is complete: every required asset (the embedding model)
   * plus at least ONE answer model (any LLM with an answerTier: the default
   * 4B or the compact 1.5B) is on disk with the right size. Gates first-run
   * navigation: if false, the app shows the setup screen instead of the chat.
   */
  async requiredModelsPresent(): Promise<boolean> {
    const ok = (s: AssetStatus) => s.present && s.sizeOnDiskBytes === s.asset.sizeBytes;
    const required = await Promise.all(MODEL_CATALOG.filter((a) => a.required).map((a) => this.statusOf(a)));
    if (!required.every(ok)) return false;
    const answer = await Promise.all(ANSWER_MODELS.map((a) => this.statusOf(a)));
    return answer.some(ok);
  }
}

function sizeChangedError(asset: CatalogModel, serverSize: number): AssetIntegrityError {
  return new AssetIntegrityError(
    "size-mismatch",
    `The download server now serves ${serverSize} bytes for ${asset.label}, not the ${asset.sizeBytes} this version of BOAR expects. Skip it for now, import the file, or update the app.`,
    true
  );
}

function rangeIgnoredError(asset: CatalogModel): AssetIntegrityError {
  return new AssetIntegrityError(
    "network",
    `The server didn't continue ${asset.label} where it stopped, so the partial download was discarded. Retry to download it from the start.`,
    false
  );
}
