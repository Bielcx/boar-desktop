/// <reference types="node" />
// The storage shims (expo-sqlite, expo-file-system[/legacy], file-hash, ram-monitor, expo-pdf-text-extract) against
// their real main-side handlers, through the in-process IPC loopback; plus the main-side guards (IPC sender, paths).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guardedHandle, onPageGone } from "../src/main/handlers/context";
import { HANDLERS } from "../src/main/handlers/index";
import { safePath } from "../src/main/storage/safePath";
import { lockedPdf, makePdf } from "../src/testing/pdf";
import PACKAGES from "../src/shared/packages.json";
import { pathToFileURL } from "node:url";
import { setupDesktop } from "./setup";
import { serve } from "./testServer";

const env = setupDesktop();
const { doc, root, dataDir } = env;
let FS: typeof import("../src/shims/expo-file-system-legacy");
let SQLite: typeof import("../src/shims/expo-sqlite");
let hash: typeof import("../src/shims/file-hash");
let ram: typeof import("../src/shims/ram-monitor");

beforeAll(async () => {
  FS = await import("../src/shims/expo-file-system-legacy");
  SQLite = await import("../src/shims/expo-sqlite");
  hash = await import("../src/shims/file-hash");
  ram = await import("../src/shims/ram-monitor");
});

describe("expo-file-system/legacy", () => {
  it("exposes the data folder's directories as file:// URIs ending in /", () => {
    expect(FS.documentDirectory).toBe(pathToFileURL(join(dataDir, "documents")).href + "/");
    expect(FS.cacheDirectory!.endsWith("/app-cache/")).toBe(true);
  });

  it("writes, reads, stats, lists, copies, moves and deletes", async () => {
    await FS.makeDirectoryAsync(`${doc}a/b`, { intermediates: true });
    await FS.writeAsStringAsync(`${doc}a/b/x.txt`, "olá");
    expect(await FS.readAsStringAsync(`${doc}a/b/x.txt`)).toBe("olá");
    expect(await FS.readAsStringAsync(`${doc}a/b/x.txt`, { encoding: FS.EncodingType.Base64 })).toBe(Buffer.from("olá").toString("base64"));
    const info = await FS.getInfoAsync(`${doc}a/b/x.txt`);
    expect(info).toMatchObject({ exists: true, isDirectory: false, size: 4 });
    expect(info.exists && info.modificationTime).toBeGreaterThan(1e9); // seconds, like expo
    expect(await FS.getInfoAsync(`${doc}nope`)).toEqual({ exists: false, uri: `${doc}nope`, isDirectory: false });
    expect((await FS.getInfoAsync(`${doc}a`)).isDirectory).toBe(true);
    await FS.copyAsync({ from: `${doc}a/b/x.txt`, to: `${doc}a/y.txt` });
    await FS.moveAsync({ from: `${doc}a/y.txt`, to: `${doc}a/z.txt` });
    expect((await FS.readDirectoryAsync(`${doc}a`)).sort()).toEqual(["b", "z.txt"]);
    await FS.deleteAsync(`${doc}a`);
    expect((await FS.getInfoAsync(`${doc}a`)).exists).toBe(false);
    await FS.deleteAsync(`${doc}a`, { idempotent: true });
    await expect(FS.deleteAsync(`${doc}a`)).rejects.toThrow();
    await expect(FS.readAsStringAsync(`${doc}missing.txt`)).rejects.toThrow();
    expect(await FS.getFreeDiskStorageAsync()).toBeGreaterThan(0);
  });

  it("refuses paths outside the data folder: ../, encoded ../, absolute, non-file URIs, symlinks out", async () => {
    writeFileSync(join(root, "secret.txt"), "secret");
    const outside = pathToFileURL(join(root, "secret.txt")).href;
    const refused = /outside the app's data folder|not a file:\/\/ URI|bad file URI/;
    await expect(FS.readAsStringAsync(`${doc}../../secret.txt`)).rejects.toThrow(refused);
    await expect(FS.readAsStringAsync(`${doc}%2e%2e/%2e%2e/secret.txt`)).rejects.toThrow(refused);
    await expect(FS.readAsStringAsync(outside)).rejects.toThrow(refused);
    await expect(FS.readAsStringAsync(join(root, "secret.txt"))).rejects.toThrow(refused);
    await expect(FS.readAsStringAsync("https://example.com/x")).rejects.toThrow(refused);
    await expect(FS.writeAsStringAsync(`${doc}../../evil.txt`, "x")).rejects.toThrow(refused);
    await expect(FS.deleteAsync(`${doc}../..`, { idempotent: true })).rejects.toThrow(refused);
    await expect(FS.moveAsync({ from: outside, to: `${doc}stolen.txt` })).rejects.toThrow(refused);
    await expect(FS.copyAsync({ from: outside, to: `${doc}stolen.txt` })).rejects.toThrow(refused);
    // A link inside the data folder that points outside it ("junction" needs no admin rights on Windows).
    mkdirSync(join(root, "outdir"));
    writeFileSync(join(root, "outdir", "s.txt"), "secret");
    symlinkSync(join(root, "outdir"), join(dataDir, "documents", "link"), "junction");
    await expect(FS.readAsStringAsync(`${doc}link/s.txt`)).rejects.toThrow(refused);
    await expect(FS.writeAsStringAsync(`${doc}link/new.txt`, "x")).rejects.toThrow(refused);
    expect(readFileSync(join(root, "secret.txt"), "utf8")).toBe("secret");
  });

  it("refuses the rest of userData (Chromium's profile), including its Cache folder", async () => {
    writeFileSync(join(dataDir, "Cookies"), "chromium");
    mkdirSync(join(dataDir, "Cache"), { recursive: true });
    const refused = /outside the app's data folder/;
    await expect(FS.readAsStringAsync(pathToFileURL(join(dataDir, "Cookies")).href)).rejects.toThrow(refused);
    await expect(FS.readAsStringAsync(`${doc}../Cookies`)).rejects.toThrow(refused);
    await expect(FS.readDirectoryAsync(pathToFileURL(join(dataDir, "Cache")).href + "/")).rejects.toThrow(refused);
    await FS.writeAsStringAsync(`${FS.cacheDirectory}ok.txt`, "x"); // the app's own cache is fine
  });

  it("refuses network paths before any disk access (no SMB connection to leak the NTLM hash)", () => {
    const spies = [vi.spyOn(fs, "existsSync"), vi.spyOn(fs, "realpathSync")];
    for (const uri of ["file://attacker.example/share/x.txt", "file:////attacker.example/share/x.txt", "file:///%5C%5C?%5CC:%5Cx"]) {
      expect(() => safePath([join(dataDir, "documents")], uri)).toThrow(/network or device path|bad file URI/);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});

describe("expo-file-system/legacy downloads", () => {
  const body = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31) % 251;
  let server: Awaited<ReturnType<typeof serve>> | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
    delete process.env.BOAR_ALLOW_HTTP_DOWNLOADS;
  });

  it("refuses anything but https", async () => {
    server = await serve(body);
    const d = FS.createDownloadResumable(server.url, `${doc}dl.bin`, {});
    await expect(d.downloadAsync()).rejects.toThrow(/only https/);
    await expect(FS.createDownloadResumable("file:///etc/passwd", `${doc}dl.bin`).downloadAsync()).rejects.toThrow(/only https/);
  });

  it("downloads with progress, then pauses and resumes with a Range request", async () => {
    process.env.BOAR_ALLOW_HTTP_DOWNLOADS = "1";
    server = await serve(body, { delayMs: 15 });
    const seen: Array<{ totalBytesWritten: number; totalBytesExpectedToWrite: number }> = [];
    let d!: InstanceType<typeof FS.DownloadResumable>;
    let paused: Promise<unknown> | null = null;
    d = FS.createDownloadResumable(server.url, `${doc}models/dl.bin`, {}, (p) => {
      seen.push(p);
      if (!paused && p.totalBytesWritten > 200_000) paused = d.pauseAsync();
    });
    await FS.makeDirectoryAsync(`${doc}models`, { intermediates: true });
    expect(await d.downloadAsync()).toBeUndefined(); // paused, like expo
    const state = (await paused) as { resumeData: string };
    const kept = Number(state.resumeData);
    expect(kept).toBeGreaterThan(200_000);
    expect(kept).toBeLessThan(body.length);
    expect(seen[0].totalBytesExpectedToWrite).toBe(body.length);

    const result = await d.resumeAsync();
    expect(result).toMatchObject({ uri: `${doc}models/dl.bin`, status: 206 });
    expect(server.ranges).toEqual(["", `bytes=${kept}-`]);
    expect(seen.at(-1)).toEqual({ totalBytesWritten: body.length, totalBytesExpectedToWrite: body.length });
    expect(readFileSync(join(dataDir, "documents", "models", "dl.bin")).equals(body)).toBe(true);
  });

  it("restarts from zero when the server ignores Range, and keeps the partial on an error status", async () => {
    process.env.BOAR_ALLOW_HTTP_DOWNLOADS = "1";
    writeFileSync(join(dataDir, "documents", "part.bin"), body.subarray(0, 1000));
    server = await serve(body, { ignoreRange: true });
    const r = await FS.createDownloadResumable(server.url, `${doc}part.bin`, {}, undefined, "1000").resumeAsync();
    expect(r?.status).toBe(200);
    expect(readFileSync(join(dataDir, "documents", "part.bin")).equals(body)).toBe(true);
    await server.close();

    writeFileSync(join(dataDir, "documents", "part.bin"), body.subarray(0, 1000));
    server = await serve(body, { status: 429 });
    await expect(FS.createDownloadResumable(server.url, `${doc}part.bin`, {}, undefined, "1000").resumeAsync()).rejects.toThrow(/HTTP 429/);
    expect(readFileSync(join(dataDir, "documents", "part.bin")).length).toBe(1000);
  });

  it("follows redirects only to allowed URLs, and stops redirect loops", async () => {
    process.env.BOAR_ALLOW_HTTP_DOWNLOADS = "1";
    server = await serve(body);
    const hop = await serve(body, { redirect: server.url });
    const out = await serve(body, { redirect: "file:///C:/Windows/win.ini" });
    const loop = await serve(body, { redirect: "/again" });
    try {
      expect(await FS.createDownloadResumable(hop.url, `${doc}redir.bin`).downloadAsync()).toMatchObject({ status: 200 });
      expect(readFileSync(join(dataDir, "documents", "redir.bin")).equals(body)).toBe(true);
      await expect(FS.createDownloadResumable(out.url, `${doc}redir2.bin`).downloadAsync()).rejects.toThrow(/only https/);
      await expect(FS.createDownloadResumable(loop.url, `${doc}redir3.bin`).downloadAsync()).rejects.toThrow(/too many redirects/);
      expect(loop.ranges.length).toBe(11);
    } finally {
      await Promise.all([hop.close(), out.close(), loop.close()]);
    }
  });

  it("doesn't put the server's response text in the error", async () => {
    process.env.BOAR_ALLOW_HTTP_DOWNLOADS = "1";
    server = await serve(body, { status: 500 });
    const err = await FS.createDownloadResumable(server.url, `${doc}e.bin`).downloadAsync().catch((e) => e);
    expect(err.message).toMatch(/HTTP 500/);
    expect(err.message).not.toContain("rate limited");
  });

  it("rejects (no crash, no hang) when the file can't be written", async () => {
    process.env.BOAR_ALLOW_HTTP_DOWNLOADS = "1";
    server = await serve(body);
    mkdirSync(join(dataDir, "documents", "isdir.bin"));
    await expect(FS.createDownloadResumable(server.url, `${doc}isdir.bin`).downloadAsync()).rejects.toThrow(/EISDIR|EPERM|illegal operation/i);
  });

  it("resuming a file that's already complete (416) succeeds without touching it", async () => {
    process.env.BOAR_ALLOW_HTTP_DOWNLOADS = "1";
    writeFileSync(join(dataDir, "documents", "full.bin"), body);
    server = await serve(body);
    const seen: number[] = [];
    const d = FS.createDownloadResumable(server.url, `${doc}full.bin`, {}, (p) => seen.push(p.totalBytesWritten), String(body.length));
    expect(await d.resumeAsync()).toMatchObject({ status: 200 });
    expect(server.ranges).toEqual([`bytes=${body.length}-`]);
    expect(seen.at(-1)).toBe(body.length);
    expect(readFileSync(join(dataDir, "documents", "full.bin")).equals(body)).toBe(true);
  });

  it("refuses a destination outside the data folder", async () => {
    process.env.BOAR_ALLOW_HTTP_DOWNLOADS = "1";
    server = await serve(body);
    await expect(FS.createDownloadResumable(server.url, `${doc}../../x.bin`).downloadAsync()).rejects.toThrow(/outside/);
  });
});

describe("expo-sqlite", () => {
  it("runs FTS5 with bm25, binds params, round-trips blobs", async () => {
    const db = await SQLite.openDatabaseAsync("t.db");
    await db.execAsync(`
      CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, title, body);
      CREATE TABLE vecs (id TEXT PRIMARY KEY, v BLOB, ok INTEGER);`);
    const rows = [
      ["1", "Black hole", "A region of spacetime where gravity is so strong nothing escapes."],
      ["2", "Coral reef", "Underwater ecosystems built by colonies of coral polyps."],
      ["3", "Neutron star", "The collapsed core of a massive star; gravity is extreme."],
    ];
    for (const r of rows) await db.runAsync("INSERT INTO docs (id, title, body) VALUES (?, ?, ?)", r);
    const hits = await db.getAllAsync<{ id: string; rank: number }>(
      `SELECT id, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank`,
      ['"gravity" OR "spacetime"']
    );
    expect(hits.map((h) => h.id)).toEqual(["1", "3"]);
    const vec = new Float32Array([0.5, -1, 2]);
    const r = await db.runAsync("INSERT INTO vecs VALUES (?, ?, ?)", ["a", new Uint8Array(vec.buffer), true]);
    expect(r).toEqual({ lastInsertRowId: 1, changes: 1 });
    const got = await db.getFirstAsync<{ v: Uint8Array; ok: number }>("SELECT v, ok FROM vecs WHERE id = ?", "a");
    expect(Array.from(new Float32Array(got!.v.buffer, got!.v.byteOffset, 3))).toEqual([0.5, -1, 2]);
    expect(got!.ok).toBe(1);
    expect(await db.getFirstAsync("SELECT * FROM vecs WHERE id = $id", { $id: "zzz" })).toBeNull();
    await db.closeAsync();
    await expect(db.getAllAsync("SELECT 1")).rejects.toThrow(/closed/);
  });

  it("commits, rolls back, and runs overlapping transactions one after another", async () => {
    const db = await SQLite.openDatabaseAsync("tx.db");
    await db.execAsync("CREATE TABLE t (n INTEGER)");
    await db.withTransactionAsync(async () => {
      await db.runAsync("INSERT INTO t VALUES (1)");
    });
    await expect(
      db.withTransactionAsync(async () => {
        await db.runAsync("INSERT INTO t VALUES (2)");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // Two at once: on Android the second fails ("within a transaction"); here it waits its turn.
    const order: string[] = [];
    const slow = (tag: string, n: number) =>
      db.withTransactionAsync(async () => {
        order.push(`${tag}-begin`);
        await db.runAsync("INSERT INTO t VALUES (?)", [n]);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`${tag}-end`);
      });
    await Promise.all([slow("a", 3), slow("b", 4)]);
    expect(order).toEqual(["a-begin", "a-end", "b-begin", "b-end"]);
    expect((await db.getAllAsync<{ n: number }>("SELECT n FROM t ORDER BY n")).map((r) => r.n)).toEqual([1, 3, 4]);
  });

  it("opens a database by plain directory path (as packs.ts does) and refuses one outside the data folder", async () => {
    const dir = `${doc}corpus`.replace(/^file:\/\//, "");
    const db = await SQLite.openDatabaseAsync("pack.sqlite", { useNewConnection: true }, dir);
    await db.execAsync("CREATE TABLE meta (key TEXT, value TEXT)");
    expect(readFileSync(join(dataDir, "documents", "corpus", "pack.sqlite")).length).toBeGreaterThan(0);
    await expect(SQLite.openDatabaseAsync("../../../evil.db")).rejects.toThrow(/outside/);
    await expect(SQLite.openDatabaseAsync("x.db", {}, root)).rejects.toThrow(/outside/);
  });

  it("refuses ATTACH and VACUUM INTO a file (SQL can't write outside the data folder); plain VACUUM still works", async () => {
    const db = await SQLite.openDatabaseAsync("guard.db");
    await db.execAsync("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)");
    const target = join(root, "escaped.db").split("\\").join("/");
    await expect(db.execAsync(`ATTACH DATABASE '${target}' AS x`)).rejects.toThrow(/not authorized|authorization denied/);
    await expect(db.execAsync(`VACUUM INTO '${target}'`)).rejects.toThrow(/not authorized|authorization denied/);
    await expect(db.runAsync("ATTACH DATABASE ? AS x", [target])).rejects.toThrow(/not authorized|authorization denied/);
    expect(existsSync(join(root, "escaped.db"))).toBe(false);
    await db.execAsync("VACUUM");
    expect(await db.getFirstAsync("PRAGMA trusted_schema")).toEqual({ trusted_schema: 0 });
    expect((await db.getAllAsync<{ n: number }>("SELECT n FROM t")).map((r) => r.n)).toEqual([1]);
    await db.closeAsync();
  });
});

describe("file-hash", () => {
  const data = Buffer.alloc(9 * 1024 * 1024, 7);
  const sha = createHash("sha256").update(data).digest("hex");

  it("hashes and copies with progress, measures size, cancels", async () => {
    writeFileSync(join(dataDir, "documents", "big.bin"), data);
    const events: number[] = [];
    const sub = hash.FileHashNative.addListener("onProgress", (e) => e.jobId === "j1" && events.push(e.bytesHashed));
    expect(await hash.FileHashNative.sha256(`${doc}big.bin`, "j1")).toBe(sha);
    sub.remove();
    expect(events.at(-1)).toBe(data.length);
    expect(await hash.FileHashNative.copyWithSha256(`${doc}big.bin`, `${doc}copy.bin`, "j2")).toEqual({ sha256: sha, bytes: data.length });
    expect(readFileSync(join(dataDir, "documents", "copy.bin")).equals(data)).toBe(true);
    expect(await hash.FileHashNative.size(`${doc}big.bin`)).toBe(data.length);
    expect(await hash.FileHashNative.size(`${doc}none.bin`)).toBe(-1);

    hash.FileHashNative.cancel("j3");
    await new Promise((r) => setTimeout(r, 0));
    const err = await hash.FileHashNative.copyWithSha256(`${doc}big.bin`, `${doc}copy2.bin`, "j3").catch((e) => e);
    expect(err.code).toBe("E_CANCELLED");
    expect((await FS.getInfoAsync(`${doc}copy2.bin`)).exists).toBe(false); // partial copy deleted
  });

  it("refuses files outside the data folder", async () => {
    writeFileSync(join(root, "outside.bin"), "x");
    await expect(hash.FileHashNative.sha256(pathToFileURL(join(root, "outside.bin")).href, "j4")).rejects.toThrow(/outside/);
    await expect(hash.FileHashNative.copyWithSha256(`${doc}big.bin`, `${doc}../../out.bin`, "j5")).rejects.toThrow(/outside/);
  });
});

describe("ram-monitor, expo-file-system File", () => {
  it("returns this machine's memory figures after the first refresh", async () => {
    await ram.refresh();
    expect(ram.getMemoryInfo().rssBytes).toBeGreaterThan(0);
    expect(ram.getDeviceTotalRamBytes()).toBeGreaterThan(ram.getAvailableRamBytes());
    expect(ram.getAvailableRamBytes()).toBeGreaterThan(0);
    expect(ram.getHardwareInfo()!.coreMaxFreqKHz.length).toBeGreaterThan(0);
  });

  it("reads total and available RAM synchronously before the first IPC answer (from boarNative.ram)", async () => {
    const real = (globalThis as any).window.boarNative;
    (globalThis as any).window = { boarNative: { ...real, invoke: () => new Promise(() => {}) } }; // IPC never answers
    try {
      vi.resetModules();
      const fresh = await import("../src/shims/ram-monitor");
      expect(fresh.getDeviceTotalRamBytes()).toBe(real.ram.totalRamBytes);
      expect(fresh.getAvailableRamBytes()).toBe(real.ram.availableRamBytes);
      expect(fresh.getDeviceTotalRamBytes()).toBeGreaterThan(0);
    } finally {
      (globalThis as any).window = { boarNative: real };
    }
  });

  it("File says it's not available on desktop", async () => {
    const { File } = await import("../src/shims/expo-file-system");
    expect(() => new File(`${doc}x`)).toThrow(/isn't available on desktop/);
  });
});

describe("expo-pdf-text-extract", () => {
  let extractText: typeof import("../src/shims/expo-pdf-text-extract").extractText;
  beforeAll(async () => {
    ({ extractText } = await import("../src/shims/expo-pdf-text-extract"));
  });

  it("returns the PDF's text, one line per line (like the native module)", async () => {
    writeFileSync(join(dataDir, "documents", "fact.pdf"), makePdf(["The Zorblat beacon", "blinks 11 times."]));
    expect(await extractText(`${doc}fact.pdf`)).toBe("The Zorblat beacon\nblinks 11 times.");
  });

  it("password-protected and corrupt PDFs fail with the native module's codes", async () => {
    writeFileSync(join(dataDir, "documents", "locked.pdf"), lockedPdf());
    await expect(extractText(`${doc}locked.pdf`)).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    writeFileSync(join(dataDir, "documents", "junk.pdf"), "this is not a PDF at all");
    const err = await extractText(`${doc}junk.pdf`).catch((e) => e);
    expect(err.code).toBe("CORRUPT_PDF");
    expect(err.message).not.toMatch(/^CORRUPT_PDF|invoking remote method/);
  });

  it("drops Electron's IPC prefix and restores the code", async () => {
    const real = (globalThis as any).window.boarNative;
    const msg = "Error invoking remote method 'expo-pdf-text-extract:extractText': Error: PASSWORD_REQUIRED: No password given";
    (globalThis as any).window = { boarNative: { ...real, invoke: () => Promise.reject(new Error(msg)) } };
    try {
      await expect(extractText(`${doc}x.pdf`)).rejects.toMatchObject({ code: "PASSWORD_REQUIRED", message: "No password given" });
    } finally {
      (globalThis as any).window = { boarNative: real };
    }
  });

  it("refuses files outside the data folder", async () => {
    writeFileSync(join(root, "outside.pdf"), makePdf(["x"]));
    await expect(extractText(pathToFileURL(join(root, "outside.pdf")).href)).rejects.toThrow(/outside/);
  });
});

describe("main-side guards", () => {
  const call = async (prefix: string, frame: { url: string; parent: unknown } | null) => {
    let handler!: (event: any, ...args: any[]) => unknown;
    guardedHandle({ handle: (_c: string, fn: any) => (handler = fn) } as any, prefix).handle("x:y", () => "ok");
    return handler({ senderFrame: frame, sender: {} });
  };

  it("serves IPC only to the app's own main frame", async () => {
    expect(await call("app://boar/", { url: "app://boar/index.html", parent: null })).toBe("ok");
    await expect(call("app://boar/", { url: "app://boar/index.html", parent: {} })).rejects.toThrow(/IPC refused/); // an iframe
    await expect(call("app://boar/", { url: "https://evil.example/", parent: null })).rejects.toThrow(/IPC refused/);
    await expect(call("app://boar/", { url: "app://boar.evil/", parent: null })).rejects.toThrow(/IPC refused/);
    await expect(call("app://boar/", { url: "file:///C:/x.html", parent: null })).rejects.toThrow(/IPC refused/);
    await expect(call("app://boar/", null)).rejects.toThrow(/IPC refused/); // frame already gone
  });

  it("onPageGone fires on a main-frame navigation to a new document and on destroy, not on in-page ones", () => {
    const sender = new EventEmitter();
    let n = 0;
    const fn = () => n++;
    onPageGone(sender as any, fn);
    onPageGone(sender as any, fn); // registered once
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    sender.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(n).toBe(0);
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(n).toBe(1);
    sender.emit("destroyed");
    expect(n).toBe(2);
  });

  it("one package list: handlers, preload channels and Metro shims all come from shared/packages.json", () => {
    const names = Object.values(PACKAGES as Record<string, string>);
    expect(Object.keys(HANDLERS).sort()).toEqual([...names].sort());
    const shims = readdirSync(join(__dirname, "../src/shims"));
    for (const n of names) expect(shims).toContain(`${n}.ts`);
  });
});
