import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopback } from "../src/testing/loopback";
import { register as sqlite } from "../src/main/handlers/expo-sqlite";
import { register as fsLegacy } from "../src/main/handlers/expo-file-system-legacy";
import { register as ramMonitor } from "../src/main/handlers/ram-monitor";
import { register as fileHash } from "../src/main/handlers/file-hash";
import { register as pdf } from "../src/main/handlers/expo-pdf-text-extract";

/** A fresh data folder with the storage handlers behind window.boarNative, as in the app. Call before importing a shim. */
export function setupDesktop() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "boar-desktop-")));
  const dataDir = join(root, "data");
  const { native, ctx } = loopback(dataDir);
  for (const register of [sqlite, fsLegacy, ramMonitor, fileHash, pdf]) register(ctx);
  (globalThis as any).window = { boarNative: native };
  return { root, dataDir, native, ctx, doc: native.dirs.document };
}
