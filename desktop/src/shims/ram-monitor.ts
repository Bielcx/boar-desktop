// Desktop shim for "ram-monitor". See shared/bridge.ts.
// The real module answers synchronously; IPC can't. So this keeps the last snapshot from main and returns it, and each
// read older than REFRESH_MS asks main for a fresh one in the background. Values therefore lag by one read. Before the
// first answer arrives, total and available RAM come from the reading main passed at window creation
// (boarNative.ram), so LlamaEngine's memory-fit check is right from the first read; memory and hardware read 0 / null.
import { native } from "../shared/bridge";

export interface MemoryInfo {
  rssBytes: number;
  totalPssBytes: number;
}

export interface HardwareInfo {
  socModel: string;
  socManufacturer: string;
  hardware: string;
  apiLevel: number;
  cpuFeatures: string;
  coreMaxFreqKHz: number[];
}

interface Snapshot {
  memory: MemoryInfo;
  totalRamBytes: number;
  availableRamBytes: number;
  hardware: HardwareInfo | null;
}

const REFRESH_MS = 500;
let last: Snapshot = {
  memory: { rssBytes: 0, totalPssBytes: 0 },
  totalRamBytes: native().ram.totalRamBytes,
  availableRamBytes: native().ram.availableRamBytes,
  hardware: null,
};
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;

/** Fetches a fresh snapshot; resolves once it's cached. Exported so tests (and startup code) can wait for the first one. */
export function refresh(): Promise<void> {
  fetchedAt = Date.now();
  inFlight ??= native()
    .invoke<Snapshot>("ram-monitor:snapshot")
    .then((s) => void (last = s))
    .catch(() => {})
    .finally(() => (inFlight = null));
  return inFlight;
}

function current(): Snapshot {
  if (Date.now() - fetchedAt > REFRESH_MS) void refresh();
  return last;
}

refresh();

export function getMemoryInfo(): MemoryInfo {
  return { ...current().memory };
}

export function getDeviceTotalRamBytes(): number {
  return current().totalRamBytes;
}

export function getHardwareInfo(): HardwareInfo | null {
  return current().hardware;
}

export function getAvailableRamBytes(): number {
  return current().availableRamBytes;
}
