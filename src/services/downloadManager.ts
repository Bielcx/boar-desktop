import { ModelManager, DownloadProgress } from "../models/ModelManager";
import { CatalogModel } from "../models/manifest";
import { notifyAssetInstalled, requirementsOf } from "../models/assetRegistry";
import { downloadErrorDetailOf, DownloadErrorDetail, errorKindOf, IntegrityErrorKind } from "../models/integrity";
import type { HashProgress } from "../models/fileHash";
import { holdWakeLockForDownload } from "./downloadWakeLock";

/**
 * Module-level (not component-local) download state, so it survives the
 * Settings screen unmounting/remounting — e.g. the user closes Settings
 * while a download is running, then reopens it later. Without this, a
 * previous version tracked download progress in ModelSetupScreen's local
 * React state: closing Settings meant losing track of the in-flight
 * download entirely, so reopening Settings showed a plain "Download"
 * button again (as if nothing were happening) even while the original
 * download was still writing to disk. Tapping "Download" again in that
 * state started a SECOND concurrent download to the same destination file
 * — a real race condition, and plausibly part of what produced the
 * truncated Qwen downloads found earlier (two writers to one path).
 *
 * `startDownload` guards against exactly that: if a download for this
 * asset is already in flight, it returns the existing one instead of
 * starting a duplicate.
 */

export interface DownloadState {
  /** True while bytes are moving or being hashed (phase downloading/verifying). */
  downloading: boolean;
  /** 0..1 within the current phase. */
  progress: number;
  error: string | null;
  /**
   * "queued" = waiting for its turn (see the download queue below).
   * "verifying" = sha256 of the finished file (streaming, native); progress
   * then counts bytes hashed. "verified" = downloaded and sha256 matched.
   */
  phase?: "queued" | "downloading" | "verifying" | "verified" | "error";
  /** Set with `error`. */
  errorKind?: IntegrityErrorKind;
  /** Retrying the same source won't help; don't auto-retry (see AssetIntegrityError). */
  permanent?: boolean;
  /**
   * Set when a download stopped part-way (errorKind "network"): a stable code
   * plus the numbers, so the UI can say it in the user's language. `error`
   * keeps the English text.
   */
  errorDetail?: DownloadErrorDetail;
  bytesWritten?: number;
  bytesExpected?: number;
  speedBytesPerSec?: number;
  etaSeconds?: number;
}

const modelManager = new ModelManager();
const state = new Map<string, DownloadState>();
const inFlight = new Map<string, Promise<void>>();
/** The asset behind each in-flight download, to cancel it (cancelAllDownloads). */
const inFlightAssets = new Map<string, CatalogModel>();
const downloadTimestamps = new Map<string, { lastBytes: number; lastTime: number; startTime: number }>();
/**
 * What changed. `progressOnly`: the same phase of one asset moved forward (bytes written or
 * hashed); a screen that only lists phases can skip it, a row showing that asset's bar can't.
 */
export interface DownloadEvent {
  assetId?: string;
  progressOnly: boolean;
}
type Listener = (event: DownloadEvent) => void;
const listeners = new Set<Listener>();

/**
 * The download queue. Big files (models, knowledge packs) download one at a time, in the order
 * they were asked for: on one connection several at once share the bandwidth, so all of them
 * finish late, instead of the first one being usable early; each also hashes its whole file at the
 * end, and checks free space only when it starts. Small files (the embedding model, map tiles, the
 * city index) run a few at a time next to them, so a 5 GB model doesn't hold up a 30 MB file.
 */
export const LARGE_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const LARGE_AT_ONCE = 1;
export const SMALL_AT_ONCE = 3;

interface Waiting {
  asset: CatalogModel;
  /** Settles the promise startDownload returned (on finish, or when taken out of the queue). */
  done: () => void;
}
const waiting: Waiting[] = [];
const runningLarge = new Set<string>();
const runningSmall = new Set<string>();

export const isLargeDownload = (asset: { sizeBytes?: number }) => (asset.sizeBytes ?? 0) >= LARGE_DOWNLOAD_BYTES;

/** Pure: the queued ids that may start now, oldest first, given what is already running. */
export function startableDownloads(
  queue: { id: string; large: boolean }[],
  running: { large: number; small: number }
): string[] {
  let large = running.large;
  let small = running.small;
  const out: string[] = [];
  for (const q of queue) {
    if (q.large ? large < LARGE_AT_ONCE : small < SMALL_AT_ONCE) {
      out.push(q.id);
      if (q.large) large++;
      else small++;
    }
  }
  return out;
}

/** Where a queued download is in its line (1 = next), or undefined when it isn't waiting. */
export function queuePosition(assetId: string): number | undefined {
  const me = waiting.find((w) => w.asset.id === assetId);
  if (!me) return undefined;
  const large = isLargeDownload(me.asset);
  return waiting.filter((w) => isLargeDownload(w.asset) === large).findIndex((w) => w.asset.id === assetId) + 1;
}

function pump() {
  const ids = startableDownloads(
    waiting.map((w) => ({ id: w.asset.id, large: isLargeDownload(w.asset) })),
    { large: runningLarge.size, small: runningSmall.size }
  );
  for (const id of ids) {
    const i = waiting.findIndex((w) => w.asset.id === id);
    if (i < 0) continue;
    const [{ asset, done }] = waiting.splice(i, 1);
    const lane = isLargeDownload(asset) ? runningLarge : runningSmall;
    lane.add(asset.id);
    run(asset).finally(() => {
      lane.delete(asset.id);
      done();
      pump();
    });
  }
}

/** Takes a download out of the queue before it started; its promise settles. False if it wasn't waiting. */
function dequeue(assetId: string): boolean {
  const i = waiting.findIndex((w) => w.asset.id === assetId);
  if (i < 0) return false;
  const [{ done }] = waiting.splice(i, 1);
  inFlight.delete(assetId);
  inFlightAssets.delete(assetId);
  state.delete(assetId);
  done();
  return true;
}

function notify(event: DownloadEvent = { progressOnly: false }) {
  listeners.forEach((l) => l(event));
}

/**
 * Progress events reach the UI at most this often per asset (5 Hz). iOS sends one per network
 * chunk (dozens to hundreds a second, no native throttle); Android's module already caps at
 * 100 ms. The bar moves in 1% steps, so faster updates change nothing on screen (perf audit #2/#4).
 */
export const PROGRESS_NOTIFY_MS = 200;
const lastProgressNotify = new Map<string, { at: number; phase: string }>();

/** Pure gate: notify a progress event when the phase changed or PROGRESS_NOTIFY_MS passed. */
export function progressDue(last: { at: number; phase: string } | undefined, phase: string, now: number): boolean {
  return !last || last.phase !== phase || now - last.at >= PROGRESS_NOTIFY_MS;
}

function notifyProgress(assetId: string, phase: string) {
  const now = Date.now();
  const last = lastProgressNotify.get(assetId);
  if (!progressDue(last, phase, now)) return;
  lastProgressNotify.set(assetId, { at: now, phase });
  notify({ assetId, progressOnly: !!last && last.phase === phase });
}

export function subscribeDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDownloadState(assetId: string): DownloadState | undefined {
  return state.get(assetId);
}

export function isDownloading(assetId: string): boolean {
  return inFlight.has(assetId);
}

/**
 * All currently-tracked download states, keyed by asset id. Used by
 * screens that don't already know the specific set of asset ids to watch —
 * e.g. ChatScreen surfacing a "download complete" toast for whatever
 * optional model the user started downloading from the Models screen,
 * without needing its own copy of the full catalog+discovered-models list
 * just to enumerate what to check.
 */
export function listDownloadStates(): Array<{ assetId: string; state: DownloadState }> {
  return Array.from(state.entries()).map(([assetId, s]) => ({ assetId, state: s }));
}

/**
 * Forgets all tracked download state without cancelling any in-flight
 * FileSystem transfer (there's no cancel handle stored here to call) — used
 * by appReset.ts right before deleting the model files those transfers
 * would have been writing to, so a stale/failed entry doesn't linger for a
 * file that no longer exists.
 */
export function resetDownloadState(): void {
  for (const w of waiting.splice(0)) w.done();
  runningLarge.clear();
  runningSmall.clear();
  state.clear();
  inFlight.clear();
  inFlightAssets.clear();
  downloadTimestamps.clear();
  lastProgressNotify.clear();
  notify();
}

/**
 * Stops every running download and waits for each to settle, then forgets
 * all download state. For "Erase everything" (appReset.ts): the files are
 * deleted right after, and a writer still running would recreate or
 * truncate them (see restartDownload for the same race).
 */
export async function cancelAllDownloads(): Promise<void> {
  // The queued ones never started: out of the queue, nothing to stop.
  for (const w of [...waiting]) dequeue(w.asset.id);
  const running = [...inFlight.entries()];
  await Promise.all(
    running.map(async ([id, promise]) => {
      const asset = inFlightAssets.get(id);
      if (asset) await modelManager.signalCancelDownload(asset);
      await promise.catch(() => {});
    })
  );
  resetDownloadState();
}

/**
 * Force-restarts a download that's stuck with no error surfaced at all —
 * no progress, no failure, just inert. This can happen with no real device
 * problem: `inFlight`/`state` are module-level singletons, so a dev Fast
 * Refresh mid-download can leave a stale in-flight entry pointing at a
 * promise nothing will ever resolve, which `startDownload`'s "already
 * running" guard then treats as legitimately in progress forever. Unlike
 * `startDownload`, this doesn't check that guard — it clears the tracked
 * state unconditionally and cancels+deletes whatever ModelManager was
 * actually holding, then starts clean.
 *
 * Ordering matters: signal cancel, then AWAIT the stale in-flight promise's
 * settlement, and only then delete the file and start over. Deleting the
 * file right after signalling cancel (without waiting) races the old
 * download's writer, which doesn't stop touching the file the instant
 * pauseAsync() resolves — if it closes its stream after the new download
 * already finished, it silently truncates the file back down, and a fully-
 * downloaded model comes back verified as 0 bytes.
 */
export async function restartDownload(asset: CatalogModel): Promise<void> {
  // Still waiting for its turn: nothing is writing to the file yet.
  dequeue(asset.id);
  const stale = inFlight.get(asset.id);
  await modelManager.signalCancelDownload(asset);
  if (stale) {
    await stale.catch(() => {});
  }
  await modelManager.deletePartialDownload(asset);
  inFlight.delete(asset.id);
  state.delete(asset.id);
  downloadTimestamps.delete(asset.id);
  notify();
  await startDownload(asset);
}

/**
 * The assets `asset` requires (catalog `requires`, e.g. the gazetteer for a
 * places pack) that aren't on the phone yet. For file imports in the offline
 * build, where nothing can be downloaded: the UI asks for these files too.
 */
export async function missingRequirements(asset: CatalogModel): Promise<CatalogModel[]> {
  const missing: CatalogModel[] = [];
  for (const req of requirementsOf(asset).assets) {
    const status = await modelManager.statusOf(req).catch(() => null);
    if (!status?.present) missing.push(req);
  }
  return missing;
}

async function startRequirements(asset: CatalogModel): Promise<void> {
  const missing = await missingRequirements(asset).catch(() => [] as CatalogModel[]);
  // startDownload no-ops for one already running; its failure shows on that asset's own row.
  for (const req of missing) startDownload(req).catch(() => {});
}

/**
 * Queues a download unless one is already queued or running for this asset (then returns that one).
 * The promise settles when it finished, failed (see its state) or was taken out of the queue.
 */
export function startDownload(asset: CatalogModel): Promise<void> {
  const existing = inFlight.get(asset.id);
  if (existing) return existing;

  let done!: () => void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  inFlight.set(asset.id, promise);
  inFlightAssets.set(asset.id, asset);
  state.set(asset.id, { downloading: true, phase: "queued", progress: 0, error: null, bytesWritten: 0, bytesExpected: asset.sizeBytes });
  waiting.push({ asset, done });
  pump();
  // One that started at once already announced itself; one that waits says so.
  if (waiting.some((w) => w.asset.id === asset.id)) notify({ assetId: asset.id, progressOnly: false });
  // A places pack without the gazetteer can't answer "restaurants in <city>" (PL-1): whatever
  // screen starts a download, what the asset requires comes with it.
  void startRequirements(asset);
  return promise;
}

/** One download, from its first byte to verified (or its error). Runs when the queue gives it a turn. */
function run(asset: CatalogModel): Promise<void> {
  const now = Date.now();
  downloadTimestamps.set(asset.id, { lastBytes: 0, lastTime: now, startTime: now });

  state.set(asset.id, {
    downloading: true,
    phase: "downloading",
    progress: 0,
    error: null,
    bytesWritten: 0,
    bytesExpected: asset.sizeBytes,
    speedBytesPerSec: 0,
    etaSeconds: 0,
  });
  // The start is the phase change; the progress events after it are progress-only (throttled).
  lastProgressNotify.set(asset.id, { at: now, phase: "downloading" });
  notify({ assetId: asset.id, progressOnly: false });

  const releaseWakeLock = holdWakeLockForDownload(asset.id);
  const promise = modelManager
    .downloadCatalogModel(asset, (p: DownloadProgress) => {
      if (p.phase === "verifying") {
        const total = p.totalBytesExpectedToWrite || asset.sizeBytes;
        state.set(asset.id, {
          downloading: true,
          phase: "verifying",
          progress: total > 0 ? Math.min(1, p.totalBytesWritten / total) : 0,
          error: null,
          bytesWritten: p.totalBytesWritten,
          bytesExpected: total,
        });
        notifyProgress(asset.id, "verifying");
        return;
      }
      const progress = p.totalBytesExpectedToWrite > 0 ? p.totalBytesWritten / p.totalBytesExpectedToWrite : 0;
      const ts = downloadTimestamps.get(asset.id);
      const currentTime = Date.now();
      let speedBytesPerSec = 0;
      let etaSeconds = 0;

      if (ts) {
        const timeDiffSec = (currentTime - ts.lastTime) / 1000;
        if (timeDiffSec >= 0.5) {
          const bytesDiff = p.totalBytesWritten - ts.lastBytes;
          speedBytesPerSec = Math.max(0, bytesDiff / timeDiffSec);
          ts.lastBytes = p.totalBytesWritten;
          ts.lastTime = currentTime;
        } else {
          const prev = state.get(asset.id);
          speedBytesPerSec = prev?.speedBytesPerSec ?? 0;
        }

        const remainingBytes = Math.max(0, p.totalBytesExpectedToWrite - p.totalBytesWritten);
        if (speedBytesPerSec > 0) {
          etaSeconds = Math.ceil(remainingBytes / speedBytesPerSec);
        }
      }

      state.set(asset.id, {
        downloading: true,
        phase: "downloading",
        progress,
        error: null,
        bytesWritten: p.totalBytesWritten,
        bytesExpected: p.totalBytesExpectedToWrite,
        speedBytesPerSec,
        etaSeconds,
      });
      notifyProgress(asset.id, "downloading");
    })
    .then(async () => {
      state.set(asset.id, {
        downloading: false,
        phase: "verified",
        progress: 1,
        error: null,
        bytesWritten: asset.sizeBytes,
        bytesExpected: asset.sizeBytes,
        speedBytesPerSec: 0,
        etaSeconds: 0,
      });
      downloadTimestamps.delete(asset.id);
      await notifyAssetInstalled(asset);
    })
    .catch((e: any) => {
      const { kind, permanent } = errorKindOf(e);
      state.set(asset.id, {
        downloading: false,
        phase: "error",
        progress: 0,
        error: e?.message ?? String(e),
        errorKind: kind,
        permanent,
        errorDetail: downloadErrorDetailOf(e),
      });
      downloadTimestamps.delete(asset.id);
    })
    .finally(() => {
      releaseWakeLock();
      inFlight.delete(asset.id);
      inFlightAssets.delete(asset.id);
      lastProgressNotify.delete(asset.id);
      notify({ assetId: asset.id, progressOnly: false });
    });
  return promise;
}

/**
 * Installs a model or pack from a user-picked file (content:// from the
 * document picker, or file://) with no network: copied into the app and
 * accepted only if its size + sha256 match a catalog entry. Holds the wake
 * lock like a download, since hashing a multi-GB file takes a while.
 * `catalog` is what the file may be (default: every asset in the registry,
 * src/models/assetRegistry.ts: the curated catalog plus places packs and
 * the gazetteer once registered). Entries need their exact sizeBytes and
 * sha256, and may have an empty sourceUrl (import-only).
 * Rejects with AssetIntegrityError (see errorKindOf) on anything else, or
 * with an AbortError (ImportAbortedError) when `signal` is aborted; the
 * partial copy is deleted either way.
 */
export async function importAssetFile(
  uri: string,
  onProgress?: HashProgress,
  signal?: AbortSignal,
  catalog?: CatalogModel[]
): Promise<CatalogModel> {
  const release = holdWakeLockForDownload(`import:${uri}`);
  try {
    const asset = await modelManager.importFromFile(uri, onProgress, signal, catalog);
    state.set(asset.id, {
      downloading: false,
      phase: "verified",
      progress: 1,
      error: null,
      bytesWritten: asset.sizeBytes,
      bytesExpected: asset.sizeBytes,
    });
    notify();
    await notifyAssetInstalled(asset);
    return asset;
  } finally {
    release();
  }
}
