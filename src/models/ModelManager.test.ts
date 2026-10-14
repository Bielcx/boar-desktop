import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

// In-memory stand-in for expo-file-system/legacy: path -> bytes.
const files = new Map<string, Buffer>();
// Pretend sizes for huge files we don't want to allocate.
const fakeSizes = new Map<string, number>();
let mtime = 1;
const mtimes = new Map<string, number>();
const put = (path: string, data: Buffer) => {
  files.set(path, data);
  mtimes.set(path, mtime++);
};

type Progress = (d: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void;
let serverBody: Buffer = Buffer.alloc(0);
let serverAnnouncedSize: number | null = null;
let dropConnectionAt: number | null = null;
let ignoreRange = false;
// Resolve with no result after this many bytes, as a paused/stalled native download does.
let stallAt: number | null = null;
const requestedOffsets: number[] = [];

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///doc/",
  getInfoAsync: async (path: string) =>
    files.has(path)
      ? { exists: true, isDirectory: false, size: fakeSizes.get(path) ?? files.get(path)!.length, modificationTime: mtimes.get(path) }
      : { exists: false },
  deleteAsync: async (path: string) => {
    files.delete(path);
  },
  makeDirectoryAsync: async () => {},
  readDirectoryAsync: async () => [],
  getFreeDiskStorageAsync: async () => 100 * 1024 ** 3,
  readAsStringAsync: async (path: string) => {
    if (!files.has(path)) throw new Error("ENOENT");
    return files.get(path)!.toString("utf8");
  },
  writeAsStringAsync: async (path: string, text: string) => put(path, Buffer.from(text)),
  moveAsync: async ({ from, to }: { from: string; to: string }) => {
    put(to, files.get(from)!);
    files.delete(from);
  },
  createDownloadResumable: (_url: string, dest: string, _opts: unknown, cb: Progress, resumeData?: string) => {
    let paused = false;
    // Mimics expo-file-system's Android legacy downloader: resumeData is the
    // byte offset, sent as "Range: bytes=N-" and appended to the file; the
    // reported total is (response length + offset).
    const run = async (from: number) => {
      requestedOffsets.push(from);
      const start = ignoreRange ? 0 : from;
      const body = serverBody.subarray(start);
      const total = (serverAnnouncedSize ?? serverBody.length) - start + from;
      cb({ totalBytesWritten: from, totalBytesExpectedToWrite: total });
      if (paused) return undefined;
      const kept = from > 0 ? files.get(dest)!.subarray(0, from) : Buffer.alloc(0);
      if (stallAt !== null && stallAt > from) {
        put(dest, Buffer.concat([kept, body.subarray(0, stallAt - from)]));
        stallAt = null;
        return undefined;
      }
      if (dropConnectionAt !== null && dropConnectionAt > from) {
        put(dest, Buffer.concat([kept, body.subarray(0, dropConnectionAt - from)]));
        dropConnectionAt = null;
        throw new Error("unexpected end of stream");
      }
      put(dest, Buffer.concat([kept, body]));
      cb({ totalBytesWritten: from + body.length, totalBytesExpectedToWrite: total });
      return { uri: dest, status: from > 0 ? 206 : 200 };
    };
    return {
      pauseAsync: async () => {
        paused = true;
      },
      downloadAsync: () => run(0),
      resumeAsync: () => run(resumeData ? Number(resumeData) : files.get(dest)?.length ?? 0),
    };
  },
}));

const excludeFromBackup = vi.fn();
vi.mock("bundled-assets", () => ({ copyBundledAssetToFile: vi.fn(), excludeFromBackup: (p: string) => excludeFromBackup(p) }));

let offline = false;
vi.mock("../config/variant", () => ({ networkAllowed: () => !offline }));

let copyHook: (() => Promise<void> | void) | null = null;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
vi.mock("./fileHash", () => ({
  // Like the real one with the native module: a Long size, or "empty" for a real 0.
  measureFile: async (uri: string) => {
    if (!files.has(uri)) return { kind: "unreadable" };
    const n = fakeSizes.get(uri) ?? files.get(uri)!.length;
    return n > 0 ? { kind: "size", bytes: n } : { kind: "empty" };
  },
  sha256OfFile: async (uri: string, onProgress?: (d: number, t: number) => void) => {
    const data = files.get(uri)!;
    onProgress?.(data.length, data.length);
    return sha(data);
  },
  copyWithSha256: async (src: string, dest: string, _p?: unknown, signal?: AbortSignal) => {
    const data = files.get(src)!;
    put(dest, data.subarray(0, 4)); // partial write, then the "user" may cancel
    await copyHook?.();
    if (signal?.aborted) {
      const e = new Error("Import cancelled");
      e.name = "AbortError";
      throw e;
    }
    put(dest, data);
    if (fakeSizes.has(src)) fakeSizes.set(dest, fakeSizes.get(src)!);
    return { sha256: sha(data), bytes: fakeSizes.get(src) ?? data.length };
  },
}));

import { clearVerifiedRecords, keptAcrossIndexUpdates, ModelManager, resetVerifiedCacheForTests } from "./ModelManager";
import { registerAssetProvider, unregisterAssetProvider } from "./assetRegistry";
import * as manifestModule from "./manifest";
import { AssetIntegrityError, DownloadError } from "./integrity";
import type { CatalogModel } from "./manifest";

const body = Buffer.from("pretend this is a GGUF file");
const asset = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: "m",
  kind: "llm",
  label: "Model",
  filename: "models/m.gguf",
  sizeBytes: body.length,
  sha256: sha(body),
  sourceUrl: "https://huggingface.co/a/b/resolve/0000000000000000000000000000000000000000/m.gguf",
  license: "MIT",
  description: "",
  required: false,
  ...over,
});
const DEST = "file:///doc/models/m.gguf";

beforeEach(() => {
  files.clear();
  mtimes.clear();
  resetVerifiedCacheForTests();
  serverBody = body;
  serverAnnouncedSize = null;
  offline = false;
  excludeFromBackup.mockClear();
  copyHook = null;
  dropConnectionAt = null;
  ignoreRange = false;
  stallAt = null;
  requestedOffsets.length = 0;
  fakeSizes.clear();
});

async function rejection(p: Promise<unknown>): Promise<AssetIntegrityError> {
  const e = await p.then(
    () => null,
    (x) => x
  );
  expect(e).toBeInstanceOf(AssetIntegrityError);
  return e as AssetIntegrityError;
}

describe("downloadCatalogModel integrity", () => {
  it("keeps a file whose sha256 matches, reports a verifying phase, and marks it verified", async () => {
    const a = asset();
    const phases: string[] = [];
    await new ModelManager([a]).downloadCatalogModel(a, (p) => phases.push(p.phase ?? "?"));
    expect(files.get(DEST)).toEqual(body);
    expect(phases).toContain("verifying");
    expect(phases.indexOf("verifying")).toBeGreaterThan(phases.indexOf("downloading"));
    const status = await new ModelManager([a]).statusOf(a);
    expect(status).toMatchObject({ present: true, checksumOk: true });
    expect(excludeFromBackup).toHaveBeenCalledWith(DEST);
  });

  it("deletes a same-size file with the wrong sha256 and fails permanently", async () => {
    serverBody = Buffer.from("pretend this is a GGUF fil3");
    const a = asset();
    const e = await rejection(new ModelManager([a]).downloadCatalogModel(a));
    expect(e.kind).toBe("hash-mismatch");
    expect(e.permanent).toBe(true);
    expect(files.has(DEST)).toBe(false);
  });

  it("aborts at the first callback when the server announces a different size (no hang, no retry loop)", async () => {
    serverAnnouncedSize = body.length + 1000;
    const a = asset();
    const e = await rejection(new ModelManager([a]).downloadCatalogModel(a));
    expect(e.kind).toBe("size-mismatch");
    expect(e.permanent).toBe(true);
    expect(files.has(DEST)).toBe(false);
  });

  it("refuses to touch the network in the offline variant", async () => {
    offline = true;
    const a = asset();
    const e = await rejection(new ModelManager([a]).downloadCatalogModel(a));
    expect(e.kind).toBe("offline-variant");
    expect(files.has(DEST)).toBe(false);
  });
});

describe("importFromFile", () => {
  const SRC = "content://picker/doc/1";

  it("identifies the file by size + sha256, whatever its name, and installs it verified", async () => {
    put(SRC, body);
    const other = asset({ id: "other", filename: "models/o.gguf", sha256: "0".repeat(64) });
    const target = asset();
    const mm = new ModelManager([other, target]);
    const installed = await mm.importFromFile(SRC);
    expect(installed.id).toBe("m");
    expect(files.get(DEST)).toEqual(body);
    expect(await mm.statusOf(target)).toMatchObject({ present: true, checksumOk: true });
    expect(excludeFromBackup).toHaveBeenCalledWith(DEST);
    expect([...files.keys()].some((k) => k.includes("/imports/"))).toBe(false);
  });

  it("rejects a file of unknown size without copying it", async () => {
    put(SRC, Buffer.from("short"));
    const e = await rejection(new ModelManager([asset()]).importFromFile(SRC));
    expect(e.kind).toBe("unknown-file");
    expect([...files.keys()]).toEqual([SRC]);
  });

  it("rejects a right-size file with the wrong hash and leaves nothing behind", async () => {
    put(SRC, Buffer.from("pretend this is a GGUF fil3"));
    const e = await rejection(new ModelManager([asset()]).importFromFile(SRC));
    expect(e.kind).toBe("hash-mismatch");
    expect(files.has(DEST)).toBe(false);
    expect([...files.keys()].filter((k) => k !== SRC && !k.endsWith("integrity.json"))).toEqual([]);
  });

  it("works in the offline variant (import needs no network)", async () => {
    offline = true;
    put(SRC, body);
    expect((await new ModelManager([asset()]).importFromFile(SRC)).id).toBe("m");
  });
});

describe("statusOf verified flag", () => {
  it("is null for a present file never hashed, and drops back to null if the file changes", async () => {
    const a = asset();
    const mm = new ModelManager([a]);
    put(DEST, body);
    expect((await mm.statusOf(a)).checksumOk).toBeNull();
    expect(await mm.verifyChecksum(a)).toBe(true);
    expect((await mm.statusOf(a)).checksumOk).toBe(true);
    put(DEST, Buffer.from("pretend this is a GGUF fil3")); // same size, new mtime
    expect((await mm.statusOf(a)).checksumOk).toBeNull();
  });
  it("is forgotten by Erase everything, on disk and in memory, even for a file that is still there", async () => {
    const a = asset();
    const mm = new ModelManager([a]);
    put(DEST, body);
    expect(await mm.verifyChecksum(a)).toBe(true);
    expect([...files.keys()].some((k) => k.endsWith("integrity.json"))).toBe(true);
    await clearVerifiedRecords();
    expect([...files.keys()].some((k) => k.endsWith("integrity.json"))).toBe(false);
    expect((await mm.statusOf(a)).checksumOk).toBeNull();
  });
});

describe("assets without a known sha256 (Hugging Face search results)", () => {
  it("are kept after a size-checked download instead of being deleted", async () => {
    const a = asset({ sha256: "" });
    await new ModelManager([a]).downloadCatalogModel(a);
    expect(files.get(DEST)).toEqual(body);
  });
});

describe("importFromFile cancellation", () => {
  const SRC = "content://picker/doc/2";

  it("rejects with an AbortError and copies nothing when already aborted", async () => {
    put(SRC, body);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new ModelManager([asset()]).importFromFile(SRC, undefined, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect([...files.keys()]).toEqual([SRC]);
  });

  it("stops mid-copy, deletes the partial file and installs nothing", async () => {
    put(SRC, body);
    const ctrl = new AbortController();
    copyHook = () => ctrl.abort();
    await expect(new ModelManager([asset()]).importFromFile(SRC, undefined, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(files.has(DEST)).toBe(false);
    expect([...files.keys()].filter((k) => k.includes("/imports/"))).toEqual([]);
  });
});

describe("interrupted downloads resume from the last byte", () => {
  it("keeps the partial file on a dropped connection, and the retry continues from there and verifies", async () => {
    const a = asset();
    const mm = new ModelManager([a]);
    dropConnectionAt = 10;
    const e = await rejection(mm.downloadCatalogModel(a));
    expect(e).toMatchObject({ kind: "network", permanent: false });
    expect(e).toBeInstanceOf(DownloadError);
    expect((e as DownloadError).detail).toEqual({ code: "interrupted", bytesDone: 10, bytesTotal: body.length });
    // The exception text stays in the log, out of what the UI may show.
    expect(e.message).not.toContain("unexpected end of stream");
    expect(e.message).toBe(`Download of ${a.label} was interrupted at 10 of ${body.length} bytes. Retry to continue from there.`);
    expect(files.get(DEST)!.length).toBe(10);
    // The UI sees it as not installed, with the resume point.
    expect(await mm.statusOf(a)).toMatchObject({ present: false, partialBytes: 10 });
    expect(files.get(DEST)!.length).toBe(10); // statusOf didn't delete it

    await new ModelManager([a]).downloadCatalogModel(a); // e.g. after an app restart
    expect(requestedOffsets).toEqual([0, 10]);
    expect(files.get(DEST)).toEqual(body);
    expect(await mm.statusOf(a)).toMatchObject({ present: true, checksumOk: true });
  });

  it("reports a stalled download as paused, with the bytes so far and the stall time, and resumes it", async () => {
    const a = asset();
    stallAt = 7;
    const e = await rejection(new ModelManager([a]).downloadCatalogModel(a));
    expect(e).toBeInstanceOf(DownloadError);
    expect(e).toMatchObject({ kind: "network", permanent: false });
    expect((e as DownloadError).detail).toEqual({ code: "paused", bytesDone: 7, bytesTotal: body.length, stallS: 60 });
    expect(e.message).toMatch(/paused \(no progress for 60s\)/);
    await new ModelManager([a]).downloadCatalogModel(a);
    expect(files.get(DEST)).toEqual(body);
  });

  it("still rejects a resumed file whose bytes don't hash right", async () => {
    const a = asset();
    dropConnectionAt = 10;
    await rejection(new ModelManager([a]).downloadCatalogModel(a));
    serverBody = Buffer.from("pretend this is a GGUF fil3"); // tail changed upstream, same size
    const e = await rejection(new ModelManager([a]).downloadCatalogModel(a));
    expect(e.kind).toBe("hash-mismatch");
    expect(files.has(DEST)).toBe(false);
  });

  it("throws the partial away when the server ignores Range, instead of appending the whole file", async () => {
    const a = asset();
    dropConnectionAt = 10;
    await rejection(new ModelManager([a]).downloadCatalogModel(a));
    ignoreRange = true;
    const e = await rejection(new ModelManager([a]).downloadCatalogModel(a));
    expect(e).toMatchObject({ kind: "network", permanent: false });
    expect(files.has(DEST)).toBe(false);
    ignoreRange = false;
    await new ModelManager([a]).downloadCatalogModel(a);
    expect(requestedOffsets.at(-1)).toBe(0);
    expect(files.get(DEST)).toEqual(body);
  });

  it("verifies a complete file already on disk without downloading again", async () => {
    const a = asset();
    put(DEST, body);
    await new ModelManager([a]).downloadCatalogModel(a);
    expect(requestedOffsets).toEqual([]);
    expect(await new ModelManager([a]).statusOf(a)).toMatchObject({ present: true, checksumOk: true });
  });

  it("deletes an oversized file instead of treating it as partial", async () => {
    const a = asset();
    put(DEST, Buffer.concat([body, Buffer.from("extra")]));
    expect(await new ModelManager([a]).statusOf(a)).toMatchObject({ present: false });
    expect(files.has(DEST)).toBe(false);
  });
});

describe("places tiles re-published by the tile index", () => {
  const TILE = "file:///doc/poi/t-N41E012.sqlite";
  const v1 = Buffer.from("rome tile, osm 2026-09-26");
  const tileAsset = (data: Buffer) =>
    asset({ id: "poi-t-N41E012", kind: "corpus", format: "poi-pack", filename: "poi/t-N41E012.sqlite", sizeBytes: data.length, sha256: sha(data), sourceUrl: "https://example/t-N41E012.sqlite" });
  const installV1 = async () => {
    put(TILE, v1);
    expect(await new ModelManager([tileAsset(v1)]).verifyChecksum(tileAsset(v1))).toBe(true);
  };

  it("applies to tiles only", () => {
    expect(keptAcrossIndexUpdates(tileAsset(v1))).toBe(true);
    expect(keptAcrossIndexUpdates({ id: "poi-europe-south", format: "poi-pack" })).toBe(false);
    expect(keptAcrossIndexUpdates(asset())).toBe(false);
  });

  it.each([
    ["bigger", Buffer.from("rome tile, osm 2026-10-15, more places")],
    ["smaller", Buffer.from("rome tile, osm 10-15")],
    ["same size, other sha256", Buffer.from("rome tile, osm 2026-10-15")],
  ])("keeps the installed version when the index lists a %s file, marked update available", async (_, v2) => {
    await installV1();
    const status = await new ModelManager([]).statusOf(tileAsset(v2));
    expect(status).toMatchObject({ present: true, checksumOk: true, updateAvailable: true, sizeOnDiskBytes: v1.length });
    expect(files.get(TILE)).toEqual(v1);
  });

  it("keeps an unverified tile bigger than the index, and still treats a smaller unverified one as a partial download", async () => {
    const v2 = Buffer.from("rome tile");
    put(TILE, v1);
    expect(await new ModelManager([]).statusOf(tileAsset(v2))).toMatchObject({ present: true, checksumOk: null, updateAvailable: true });
    expect(files.has(TILE)).toBe(true);
    put(TILE, v2.subarray(0, 4));
    expect(await new ModelManager([]).statusOf(tileAsset(v1))).toMatchObject({ present: false, partialBytes: 4 });
  });

  it("an up-to-date tile has no update", async () => {
    await installV1();
    expect((await new ModelManager([]).statusOf(tileAsset(v1))).updateAvailable).toBeUndefined();
  });

  it("downloading the new version starts over instead of resuming onto the old file", async () => {
    await installV1();
    const v2 = Buffer.from("rome tile, osm 2026-10-15, more places");
    serverBody = v2;
    await new ModelManager([]).downloadCatalogModel(tileAsset(v2));
    expect(requestedOffsets).toEqual([0]);
    expect(files.get(TILE)).toEqual(v2);
    expect(await new ModelManager([]).statusOf(tileAsset(v2))).toMatchObject({ present: true, checksumOk: true });
  });
});

describe("importFromFile with an extended catalog (place packs, gazetteer)", () => {
  const SRC = "content://picker/doc/3";
  const pack = Buffer.from("offline places of somewhere, OSM-derived");
  const poi = asset({ id: "poi-x", kind: "corpus", format: "poi-pack", filename: "corpus/poi-x.sqlite", sourceUrl: "", sizeBytes: pack.length, sha256: sha(pack) });

  it("accepts an import-only entry (empty sourceUrl) passed in the catalog", async () => {
    put(SRC, pack);
    const got = await new ModelManager([asset()]).importFromFile(SRC, undefined, undefined, [asset(), poi]);
    expect(got.id).toBe("poi-x");
    expect(files.get("file:///doc/corpus/poi-x.sqlite")).toEqual(pack);
  });

  it("is unknown-file with the default catalog, and ignores entries without a sha256", async () => {
    put(SRC, pack);
    expect((await rejection(new ModelManager([asset()]).importFromFile(SRC))).kind).toBe("unknown-file");
    const noHash = { ...poi, sha256: "" };
    expect((await rejection(new ModelManager([]).importFromFile(SRC, undefined, undefined, [noHash]))).kind).toBe("unknown-file");
  });
});

describe("import size limits", () => {
  const SRC = "content://picker/doc/4";

  it("rejects a file bigger than anything installable before copying or hashing it", async () => {
    put(SRC, body);
    fakeSizes.set(SRC, 40 * 1000 ** 3);
    const e = await rejection(new ModelManager([asset()]).importFromFile(SRC));
    expect(e).toMatchObject({ kind: "too-large", permanent: true });
    expect(e.message).toMatch(/This file is 40 GB; nothing BOAR can install is larger than 30 GB/);
    expect([...files.keys()]).toEqual([SRC]);
  });

  it("imports a file over 2 GB (its size doesn't overflow a 32-bit int; IMP-2GB)", async () => {
    const big = 2_497_281_120; // Qwen3-4B-Instruct-2507 Q4_K_M, > 2^31 - 1
    expect(big).toBeGreaterThan(2 ** 31 - 1);
    const a = asset({ sizeBytes: big, sha256: sha(body) });
    put(SRC, body);
    fakeSizes.set(SRC, big);
    const installed = await new ModelManager([a]).importFromFile(SRC);
    expect(installed.id).toBe(a.id);
  });

  it("tells a really empty file (0 bytes, measured natively) from one it can't read, and both from an unknown one", async () => {
    put(SRC, Buffer.alloc(0));
    expect(await rejection(new ModelManager([asset()]).importFromFile(SRC))).toMatchObject({ kind: "empty-file", permanent: true });
    expect(await rejection(new ModelManager([asset()]).importFromFile("content://picker/gone"))).toMatchObject({
      kind: "unreadable-file",
      message: "The selected file could not be read.",
    });
  });

  it("logs a refusal decided before any copy, so a device log shows why nothing happened", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      put(SRC, Buffer.from("a pack from an older upload, one byte longer"));
      const e = await rejection(new ModelManager([asset()]).importFromFile(SRC));
      expect(e.kind).toBe("unknown-file");
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(`[ModelManager:download:import] importing ${SRC}`);
      expect(lines.some((l) => l.startsWith(`[ModelManager:download:import] refused ${SRC}: unknown-file: This file (`))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

describe("asset registry integration", () => {
  const SRC = "content://picker/doc/5";
  const gazetteer = Buffer.from("GeoNames cities15000, as SQLite");

  it("a default ModelManager imports any registered asset, e.g. the gazetteer, with no download URL", async () => {
    registerAssetProvider("poi", () => [
      asset({ id: "poi-world-places", kind: "corpus", format: "poi-pack", filename: "poi/world-places.sqlite", sourceUrl: "", sizeBytes: gazetteer.length, sha256: sha(gazetteer) }),
    ]);
    try {
      put(SRC, gazetteer);
      const got = await new ModelManager().importFromFile(SRC);
      expect(got.id).toBe("poi-world-places");
      expect(files.get("file:///doc/poi/world-places.sqlite")).toEqual(gazetteer);
    } finally {
      unregisterAssetProvider("poi");
    }
  });

  it("refuses to download an asset that has no source URL yet, pointing to import", async () => {
    const a = asset({ sourceUrl: "" });
    const e = await rejection(new ModelManager([a]).downloadCatalogModel(a));
    expect(e).toMatchObject({ kind: "no-source", permanent: true });
    expect(e.message).toMatch(/Import the file/);
  });
});

describe("requiredModelsPresent (setup complete)", () => {
  const { MODEL_CATALOG: CAT, DEFAULT_ANSWER_MODEL: DEF, COMPACT_ANSWER_MODEL: COMP } = manifestModule;
  const embedding = CAT.find((m) => m.kind === "embedding" && m.required)!;

  it("needs the embedding model plus ONE answer model, default or compact", async () => {
    // Real sizes would allocate GBs; shrink the catalog entries' files with fakeSizes instead.
    for (const a of [embedding, DEF, COMP]) fakeSizes.set(`file:///doc/${a.filename}`, a.sizeBytes);
    const mm = new ModelManager();
    const mark = (a: { filename: string }) => put(`file:///doc/${a.filename}`, Buffer.alloc(1));
    expect(await mm.requiredModelsPresent()).toBe(false);
    mark(embedding);
    expect(await mm.requiredModelsPresent()).toBe(false);
    mark(COMP);
    expect(await mm.requiredModelsPresent()).toBe(true);
    files.delete(`file:///doc/${COMP.filename}`);
    mark(DEF);
    expect(await mm.requiredModelsPresent()).toBe(true);
    files.delete(`file:///doc/${embedding.filename}`);
    expect(await mm.requiredModelsPresent()).toBe(false);
  });
});
