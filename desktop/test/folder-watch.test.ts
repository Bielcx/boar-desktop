import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diff, goodTimeForHeavyWork, HEAVY, isHeavy, scanFolder, watchFolder, type Manifest } from "../src/main/watch";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watched folder", () => {
  let dir: string;
  let stop = () => {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boar-watch-"));
  });
  afterEach(() => {
    stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("add, change and delete, each seen once after the debounce", async () => {
    let calls = 0;
    stop = watchFolder(dir, 300, () => calls++);
    let imported: Manifest = {};
    // What the handler does on each callback: scan, diff with what was imported, "import" it.
    const settle = async () => {
      const now = await scanFolder(dir);
      const plan = diff(now, imported);
      imported = now;
      return plan;
    };

    // A burst of writes (an editor saving, a copy of several files) is one callback.
    writeFileSync(join(dir, "obra.txt"), "a");
    writeFileSync(join(dir, "obra.txt"), "ab");
    writeFileSync(join(dir, "planta.pdf"), "%PDF");
    writeFileSync(join(dir, "foto.jpg"), "x"); // not an importable format
    writeFileSync(join(dir, "~$rascunho.md"), "lock"); // an Office lock file
    await wait(150);
    expect(calls).toBe(0); // still inside the debounce
    await wait(600);
    expect(calls).toBe(1);
    expect(await settle()).toEqual({ upserts: ["obra.txt", "planta.pdf"], removes: [] });

    writeFileSync(join(dir, "obra.txt"), "abc, changed");
    await wait(800);
    expect(calls).toBe(2);
    expect(await settle()).toEqual({ upserts: ["obra.txt"], removes: [] });

    // Same size, newer mtime: still a change.
    writeFileSync(join(dir, "obra.txt"), "xyz, changed");
    utimesSync(join(dir, "obra.txt"), new Date(), new Date(Date.now() + 5000));
    await wait(800);
    expect(await settle()).toEqual({ upserts: ["obra.txt"], removes: [] });

    unlinkSync(join(dir, "planta.pdf"));
    await wait(800);
    expect(await settle()).toEqual({ upserts: [], removes: ["planta.pdf"] });
    expect(await settle()).toEqual({ upserts: [], removes: [] }); // nothing left to do
  });

  it("a folder that doesn't exist is watched as nothing, without throwing", async () => {
    stop = watchFolder(join(dir, "gone"), 50, () => {});
    await expect(scanFolder(join(dir, "gone"))).rejects.toThrow();
  });

  it("big batches wait for an idle computer on mains power", () => {
    const now: Manifest = {};
    const names = Array.from({ length: HEAVY.files + 1 }, (_, i) => `n${i}.txt`);
    for (const n of names) now[n] = [100, 1];
    expect(isHeavy({ upserts: names.slice(0, 3), removes: [] }, now)).toBe(false); // small: right away
    expect(isHeavy({ upserts: names, removes: [] }, now)).toBe(true); // many files
    now["big.md"] = [HEAVY.bytes + 1, 1];
    expect(isHeavy({ upserts: ["big.md"], removes: [] }, now)).toBe(true); // many bytes
    const pdfs = Array.from({ length: HEAVY.pdfs + 1 }, (_, i) => `p${i}.PDF`);
    for (const n of pdfs) now[n] = [1000, 1];
    expect(isHeavy({ upserts: pdfs, removes: [] }, now)).toBe(true); // several PDFs

    expect(goodTimeForHeavyWork({ onBatteryPower: false, getSystemIdleTime: () => HEAVY.idleSeconds })).toBe(true);
    expect(goodTimeForHeavyWork({ onBatteryPower: true, getSystemIdleTime: () => 3600 })).toBe(false);
    expect(goodTimeForHeavyWork({ onBatteryPower: false, getSystemIdleTime: () => 5 })).toBe(false);
  });
});
