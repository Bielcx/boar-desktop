/**
 * The watched-folder engine, without Electron (so vitest runs it on a temp folder): list a folder's importable files,
 * compare with what was last imported, and call back once a burst of file events has settled.
 * handlers/folder-watch.ts adds the IPC, the copies into app-cache, the power checks and the tray.
 *
 * ponytail: top level of the folder only, no subfolders; readdir({ recursive }) if people ask for them.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Same formats as the import screen (src/services/documentImporter.ts SUPPORTED_MIME_TYPES). */
export const WATCHED_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".pdf"]);
/** The importer's largest cap (PDFs, src/models/importLimits.ts): anything bigger isn't even copied. */
export const MAX_FILE_BYTES = 100 * 1000 ** 2;

/** File name -> [size, mtimeMs]: enough to tell a changed file without reading it. */
export type Manifest = Record<string, [number, number]>;

export async function scanFolder(dir: string): Promise<Manifest> {
  const out: Manifest = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || !WATCHED_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
    // ~$ and .~ are Office/LibreOffice lock files; a file can also vanish between readdir and stat.
    if (e.name.startsWith("~$") || e.name.startsWith(".~")) continue;
    const s = await stat(path.join(dir, e.name)).catch(() => null);
    if (s && s.size <= MAX_FILE_BYTES) out[e.name] = [s.size, Math.floor(s.mtimeMs)];
  }
  return out;
}

export interface Plan {
  /** New or changed since the last import. */
  upserts: string[];
  /** Imported before, gone now. */
  removes: string[];
}

export function diff(now: Manifest, before: Manifest): Plan {
  const upserts = Object.keys(now).filter((n) => !before[n] || before[n][0] !== now[n][0] || before[n][1] !== now[n][1]);
  const removes = Object.keys(before).filter((n) => !now[n]);
  return { upserts, removes };
}

/** Thresholds of a "big" import, one that waits for an idle computer on mains power. Calibration knobs. */
export const HEAVY = { files: 10, bytes: 5 * 1000 ** 2, pdfs: 3, idleSeconds: 120 };

export function isHeavy(plan: Plan, now: Manifest): boolean {
  const bytes = plan.upserts.reduce((sum, n) => sum + now[n][0], 0);
  const pdfs = plan.upserts.filter((n) => n.toLowerCase().endsWith(".pdf")).length;
  return plan.upserts.length > HEAVY.files || bytes > HEAVY.bytes || pdfs > HEAVY.pdfs;
}

/** Electron's powerMonitor, or a test stand-in. */
export interface Power {
  getSystemIdleTime(): number;
  onBatteryPower: boolean;
}

export function goodTimeForHeavyWork(power: Power): boolean {
  return !power.onBatteryPower && power.getSystemIdleTime() >= HEAVY.idleSeconds;
}

/**
 * fs.watch on `dir`, calling `onChange` once no event came for `debounceMs` (an editor saving fires several, a copy
 * of many files fires hundreds). A folder that disappears just stops sending events; the caller's periodic rescan
 * still sees it.
 */
export function watchFolder(dir: string, debounceMs: number, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let w: FSWatcher | null = null;
  try {
    w = watch(dir, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    });
    w.on("error", () => w?.close());
  } catch {
    // Folder gone or unreadable: nothing to watch until it comes back (the rescan picks it up then).
  }
  return () => {
    clearTimeout(timer);
    w?.close();
  };
}
