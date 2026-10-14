import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const acquireMock = vi.fn(() => true);
const releaseMock = vi.fn();
vi.mock("download-wake-lock", () => ({
  acquireDownloadWakeLock: () => acquireMock(),
  releaseDownloadWakeLock: () => releaseMock(),
}));

type Deferred = { resolve: () => void; reject: (e: unknown) => void };
const pending = new Map<string, Deferred>();
const downloadMock = vi.fn(
  (asset: { id: string }, _onProgress?: (p: any) => void) =>
    new Promise<void>((resolve, reject) => {
      pending.set(asset.id, { resolve, reject });
    })
);
const signalCancelMock = vi.fn(async (asset: { id: string }) => {
  pending.get(asset.id)?.reject(new Error("Download paused"));
});

vi.mock("../models/ModelManager", () => ({
  ModelManager: class {
    downloadCatalogModel(asset: any, onProgress?: (p: any) => void) {
      return downloadMock(asset, onProgress);
    }
    signalCancelDownload(asset: any) {
      return signalCancelMock(asset);
    }
    async deletePartialDownload() {}
    async statusOf(asset: { id: string }) {
      return { present: presentIds.has(asset.id) };
    }
  },
}));
const presentIds = new Set<string>();

import { cancelAllDownloads, getDownloadState, LARGE_DOWNLOAD_BYTES, missingRequirements, PROGRESS_NOTIFY_MS, progressDue, queuePosition, resetDownloadState, restartDownload, startableDownloads, startDownload, subscribeDownloads, type DownloadEvent } from "./downloadManager";
import { onAssetInstalled, registerAssetProvider, unregisterAssetProvider } from "../models/assetRegistry";
import { AssetIntegrityError, DownloadError } from "../models/integrity";

const asset = (id: string) => ({ id, sizeBytes: 100 }) as any;
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetDownloadState();
  pending.clear();
  acquireMock.mockClear();
  releaseMock.mockClear();
  downloadMock.mockClear();
});

describe("download wake lock", () => {
  it("is acquired when a download starts, and released when it succeeds", async () => {
    const p = startDownload(asset("a"));
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
    pending.get("a")!.resolve();
    await p;
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(getDownloadState("a")?.error).toBeNull();
  });

  it("is released when the download fails", async () => {
    const p = startDownload(asset("a"));
    pending.get("a")!.reject(new Error("failed verification — got 0 bytes"));
    await p;
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(getDownloadState("a")?.error).toMatch(/verification/);
  });

  it("is released on an unexpected exception inside the download", async () => {
    downloadMock.mockImplementationOnce(async () => {
      throw new TypeError("boom");
    });
    await startDownload(asset("a"));
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("is released when a download is cancelled, and re-acquired for its restart", async () => {
    const first = startDownload(asset("a"));
    const restart = restartDownload(asset("a"));
    await first;
    await settle();
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(acquireMock).toHaveBeenCalledTimes(2);
    pending.get("a")!.resolve();
    await restart;
    expect(releaseMock).toHaveBeenCalledTimes(2);
  });

  it("does not take a second lock when the same download is started twice", async () => {
    const p1 = startDownload(asset("a"));
    const p2 = startDownload(asset("a"));
    expect(p2).toBe(p1);
    expect(acquireMock).toHaveBeenCalledTimes(1);
    pending.get("a")!.resolve();
    await p1;
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("shares one lock between concurrent downloads, released after the last one", async () => {
    const a = startDownload(asset("a"));
    const b = startDownload(asset("b"));
    expect(acquireMock).toHaveBeenCalledTimes(1);
    pending.get("a")!.resolve();
    await a;
    expect(releaseMock).not.toHaveBeenCalled();
    pending.get("b")!.reject(new Error("network"));
    await b;
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("never lets a wake lock error break the download", async () => {
    acquireMock.mockImplementationOnce(() => {
      throw new Error("no permission");
    });
    const p = startDownload(asset("a"));
    pending.get("a")!.resolve();
    await expect(p).resolves.toBeUndefined();
    expect(getDownloadState("a")?.progress).toBe(1);
  });
});

describe("download phases and error kinds", () => {
  it("goes downloading -> verifying -> verified", async () => {
    const p = startDownload(asset("a"));
    const onProgress = downloadMock.mock.calls[0][1]!;
    expect(getDownloadState("a")?.phase).toBe("downloading");
    onProgress({ phase: "downloading", totalBytesWritten: 50, totalBytesExpectedToWrite: 100 });
    expect(getDownloadState("a")).toMatchObject({ phase: "downloading", progress: 0.5 });
    onProgress({ phase: "verifying", totalBytesWritten: 25, totalBytesExpectedToWrite: 100 });
    expect(getDownloadState("a")).toMatchObject({ phase: "verifying", progress: 0.25, downloading: true });
    pending.get("a")!.resolve();
    await p;
    expect(getDownloadState("a")).toMatchObject({ phase: "verified", progress: 1, downloading: false });
  });

  it("exposes kind and permanent for integrity failures so the UI can skip auto-retry", async () => {
    const p = startDownload(asset("a"));
    pending.get("a")!.reject(new AssetIntegrityError("hash-mismatch", "wrong sha256", true));
    await p;
    expect(getDownloadState("a")).toMatchObject({ phase: "error", errorKind: "hash-mismatch", permanent: true });
  });

  it("passes a stopped download's code and numbers through, for a translated message", async () => {
    const p = startDownload(asset("a"));
    const detail = { code: "paused", bytesDone: 40, bytesTotal: 100, stallS: 60 } as const;
    pending.get("a")!.reject(new DownloadError(detail, "Download of A paused (no progress for 60s)"));
    await p;
    expect(getDownloadState("a")).toMatchObject({ phase: "error", errorKind: "network", permanent: false, errorDetail: detail });
  });

  it("treats plain errors as transient (retry allowed)", async () => {
    const p = startDownload(asset("a"));
    pending.get("a")!.reject(new Error("socket closed"));
    await p;
    expect(getDownloadState("a")).toMatchObject({ phase: "error", errorKind: "unknown", permanent: false });
  });
});

describe("remounting the UI (font scale change, FS-1)", () => {
  it("a running download outlives the screen that started it: a new subscriber sees it, and Download again doesn't start a second one", async () => {
    // The screen that starts the download, then unmounts (key change at the navigator).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const seenByOld: number[] = [];
    const unsubscribeOld = subscribeDownloads(() => seenByOld.push(getDownloadState("a")?.bytesWritten ?? -1));
    const first = startDownload(asset("a"));
    downloadMock.mock.calls[0][1]!({ phase: "downloading", totalBytesWritten: 40, totalBytesExpectedToWrite: 100 });
    unsubscribeOld();

    // The remounted screen: fresh subscription, same module state.
    const seenByNew: number[] = [];
    const unsubscribeNew = subscribeDownloads(() => seenByNew.push(getDownloadState("a")?.bytesWritten ?? -1));
    expect(getDownloadState("a")).toMatchObject({ downloading: true, bytesWritten: 40, bytesExpected: 100 });
    const again = startDownload(asset("a"));
    expect(again).toBe(first);
    expect(downloadMock).toHaveBeenCalledTimes(1);

    // Past the 5 Hz progress gate (PROGRESS_NOTIFY_MS).
    vi.setSystemTime(PROGRESS_NOTIFY_MS);
    downloadMock.mock.calls[0][1]!({ phase: "downloading", totalBytesWritten: 90, totalBytesExpectedToWrite: 100 });
    vi.useRealTimers();
    pending.get("a")!.resolve();
    await first;
    expect(seenByNew).toContain(90);
    expect(seenByOld).not.toContain(90);
    expect(getDownloadState("a")).toMatchObject({ phase: "verified", downloading: false });
    unsubscribeNew();
  });
});

describe("cancelAllDownloads (Erase everything)", () => {
  it("cancels every running download and waits for each to settle before forgetting them", async () => {
    signalCancelMock.mockClear();
    const a = startDownload(asset("a"));
    const b = startDownload(asset("b"));
    let settled = false;
    const done = cancelAllDownloads().then(() => (settled = true));
    await settle();
    expect(signalCancelMock.mock.calls.map((c) => c[0].id).sort()).toEqual(["a", "b"]);
    await Promise.all([a, b]);
    await done;
    expect(settled).toBe(true);
    expect(getDownloadState("a")).toBeUndefined();
    expect(getDownloadState("b")).toBeUndefined();
  });

  it("does nothing when no download is running", async () => {
    signalCancelMock.mockClear();
    await cancelAllDownloads();
    expect(signalCancelMock).not.toHaveBeenCalled();
  });
});

describe("assets installed together (PL-1: a places pack needs the gazetteer)", () => {
  const gazetteer = { id: "poi-world-places", filename: "poi/world-places.sqlite", sizeBytes: 10 } as any;
  const berlin = { id: "poi-berlin", filename: "poi/berlin.sqlite", sizeBytes: 20, requires: ["poi-world-places"] } as any;

  beforeEach(() => {
    presentIds.clear();
    registerAssetProvider("test-places", () => [gazetteer, berlin]);
  });
  afterEach(() => unregisterAssetProvider("test-places"));

  it("downloading a places pack also downloads the gazetteer when it's missing", async () => {
    startDownload(berlin);
    await settle();
    expect(downloadMock.mock.calls.map((c) => c[0].id).sort()).toEqual(["poi-berlin", "poi-world-places"]);
    expect(getDownloadState("poi-world-places")).toMatchObject({ downloading: true });
  });

  it("doesn't download the gazetteer again when it's installed or already downloading", async () => {
    presentIds.add("poi-world-places");
    startDownload(berlin);
    await settle();
    expect(downloadMock.mock.calls.map((c) => c[0].id)).toEqual(["poi-berlin"]);

    presentIds.clear();
    resetDownloadState();
    downloadMock.mockClear();
    startDownload(gazetteer);
    startDownload(berlin);
    await settle();
    expect(downloadMock.mock.calls.map((c) => c[0].id).sort()).toEqual(["poi-berlin", "poi-world-places"]);
  });

  it("tells a file import what else to import", async () => {
    expect((await missingRequirements(berlin)).map((a) => a.id)).toEqual(["poi-world-places"]);
    presentIds.add("poi-world-places");
    expect(await missingRequirements(berlin)).toEqual([]);
    expect(await missingRequirements(gazetteer)).toEqual([]);
  });
});


describe("installed notification (the gazetteer's tile index reloads on it)", () => {
  it("fires once a download is verified, and not when it fails", async () => {
    const seen: string[] = [];
    const off = onAssetInstalled((a) => seen.push(a.id));
    const ok = startDownload(asset("gaz"));
    pending.get("gaz")!.resolve();
    await ok;
    const bad = startDownload(asset("broken"));
    pending.get("broken")!.reject(new Error("network"));
    await bad;
    off();
    expect(seen).toEqual(["gaz"]);
  });
});

describe("progress notifications (perf audit #2/#4: iOS sends one event per network chunk)", () => {
  afterEach(() => vi.useRealTimers());

  it("progressDue: on a phase change, or once PROGRESS_NOTIFY_MS passed", () => {
    expect(progressDue(undefined, "downloading", 0)).toBe(true);
    expect(progressDue({ at: 1000, phase: "downloading" }, "downloading", 1000 + PROGRESS_NOTIFY_MS - 1)).toBe(false);
    expect(progressDue({ at: 1000, phase: "downloading" }, "downloading", 1000 + PROGRESS_NOTIFY_MS)).toBe(true);
    expect(progressDue({ at: 1000, phase: "downloading" }, "verifying", 1001)).toBe(true);
  });

  it("caps a burst of native events at 5 Hz, keeps the state fresh, and marks phase changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const events: DownloadEvent[] = [];
    const off = subscribeDownloads((e) => events.push(e));
    const p = startDownload(asset("big"));
    const onProgress = downloadMock.mock.calls[0][1]!;
    // 100 chunks in 100 ms, then one more at 250 ms.
    for (let i = 1; i <= 100; i++) {
      vi.setSystemTime(i);
      onProgress({ totalBytesWritten: i, totalBytesExpectedToWrite: 1000 });
    }
    vi.setSystemTime(250);
    onProgress({ totalBytesWritten: 250, totalBytesExpectedToWrite: 1000 });
    vi.setSystemTime(251);
    onProgress({ phase: "verifying", totalBytesWritten: 1, totalBytesExpectedToWrite: 1000 });
    expect(getDownloadState("big")?.phase).toBe("verifying");
    expect(events).toEqual([
      { assetId: "big", progressOnly: false }, // start
      { assetId: "big", progressOnly: true }, // 250 ms
      { assetId: "big", progressOnly: false }, // verifying
    ]);
    pending.get("big")!.resolve();
    await p;
    off();
    expect(events.at(-1)).toEqual({ assetId: "big", progressOnly: false });
  });
});

describe("download queue: big files one at a time, small ones alongside", () => {
  const big = (id: string) => ({ id, sizeBytes: LARGE_DOWNLOAD_BYTES * 20 }) as any;
  const started = () => downloadMock.mock.calls.map((c) => c[0].id);

  it("picks what may start: one big, up to three small, oldest first", () => {
    const q = (id: string, large: boolean) => ({ id, large });
    expect(startableDownloads([q("a", true), q("b", true), q("t1", false)], { large: 0, small: 0 })).toEqual(["a", "t1"]);
    expect(startableDownloads([q("b", true), q("t2", false)], { large: 1, small: 3 })).toEqual([]);
    expect(startableDownloads([q("t1", false), q("t2", false), q("t3", false), q("t4", false)], { large: 0, small: 1 })).toEqual(["t1", "t2"]);
  });

  it("queues the second big model behind the first and starts it when the first is done", async () => {
    const first = startDownload(big("qwen3-4b"));
    const second = startDownload(big("lfm2.5"));
    expect(started()).toEqual(["qwen3-4b"]);
    expect(getDownloadState("lfm2.5")).toMatchObject({ downloading: true, phase: "queued", progress: 0 });
    expect(queuePosition("lfm2.5")).toBe(1);
    // Asking again doesn't start a second copy, in the queue or running.
    expect(startDownload(big("lfm2.5"))).toBe(second);
    pending.get("qwen3-4b")!.resolve();
    await first;
    await settle();
    expect(started()).toEqual(["qwen3-4b", "lfm2.5"]);
    expect(getDownloadState("lfm2.5")?.phase).toBe("downloading");
    pending.get("lfm2.5")!.resolve();
    await second;
  });

  it("lets a small file through while a big one downloads", () => {
    startDownload(big("qwen3-4b"));
    startDownload(asset("embedding"));
    expect(started()).toEqual(["qwen3-4b", "embedding"]);
  });

  it("moves on after a failure too", async () => {
    const first = startDownload(big("a"));
    const second = startDownload(big("b"));
    pending.get("a")!.reject(new Error("network down"));
    await first;
    await settle();
    expect(getDownloadState("a")?.phase).toBe("error");
    expect(started()).toEqual(["a", "b"]);
    pending.get("b")!.resolve();
    await second;
  });

  it("restarts a queued download without waiting for its turn", async () => {
    startDownload(big("a"));
    const queued = startDownload(big("b"));
    const restarted = restartDownload(big("b"));
    await queued; // settled when it left the queue, not hanging until "a" finishes
    await settle();
    expect(getDownloadState("b")?.phase).toBe("queued");
    pending.get("a")!.resolve();
    await settle();
    await settle();
    expect(started()).toEqual(["a", "b"]);
    pending.get("b")!.resolve();
    await restarted;
  });

  it("cancelling everything settles the queued ones too", async () => {
    startDownload(big("a"));
    const queued = startDownload(big("b"));
    await cancelAllDownloads();
    await queued;
    expect(getDownloadState("b")).toBeUndefined();
    expect(started()).toEqual(["a"]);
  });
});
