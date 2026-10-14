import { arch, cpus, freemem, totalmem } from "node:os";
import type { HandlerContext } from "./context";

/** Everything the ram-monitor shim caches, in one round trip. Shapes match modules/ram-monitor/index.ts. */
export function snapshot() {
  const rss = process.memoryUsage().rss;
  const cores = cpus();
  return {
    // The models run in this (main) process, so its RSS is the figure the app's RAM bar is about.
    // ponytail: no PSS on desktop; rss stands in for it.
    memory: { rssBytes: rss, totalPssBytes: rss },
    totalRamBytes: totalmem(),
    availableRamBytes: freemem(),
    hardware: {
      socModel: cores[0]?.model.trim() ?? "",
      socManufacturer: "",
      hardware: arch(),
      apiLevel: 0,
      cpuFeatures: "",
      coreMaxFreqKHz: cores.map((c) => c.speed * 1000),
    },
  };
}

export function register(ctx: HandlerContext): void {
  ctx.ipcMain.handle("ram-monitor:snapshot", () => snapshot());
}
