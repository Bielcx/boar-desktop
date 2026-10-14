import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HandlerContext } from "./context";

/**
 * "LibraryShare" (Settings > Share my library): whether other apps may search the library through the MCP server
 * (src/mcp/server.ts, started by the client: clientConfig below), and which collections they see. Stored in <userData>/mcp.json, outside the
 * folders the page can reach as files; the server reads it again on every call, so a change applies right away.
 * Off by default. Notes: docs/09-mcp.md.
 */
export interface LibraryShareConfig {
  enabled: boolean;
  /** Imported collections (custom_collections.id) other apps may search. New collections aren't shared until ticked. */
  collections: string[];
  /** The bundled articles and downloaded knowledge packs (Wikipedia...): public text, on unless unticked. */
  builtin: boolean;
}

export const DEFAULT_CONFIG: LibraryShareConfig = { enabled: false, collections: [], builtin: true };

export const configFile = (dataDir: string) => path.join(dataDir, "mcp.json");

/** Anything that isn't a valid config (a missing file, bad JSON, wrong types) reads as the default: off. */
export function parseConfig(value: unknown): LibraryShareConfig {
  const v = value as Partial<LibraryShareConfig> | null;
  if (!v || typeof v !== "object") return { ...DEFAULT_CONFIG };
  const collections = Array.isArray(v.collections)
    ? v.collections.filter((c): c is string => typeof c === "string" && c.length > 0 && c.length <= 200).slice(0, 1000)
    : [];
  return { enabled: v.enabled === true, collections: [...new Set(collections)], builtin: v.builtin !== false };
}

export function readConfig(dataDir: string): LibraryShareConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(configFile(dataDir), "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * The claude_desktop_config.json entry that starts the server: this very executable (BOAR.exe, or Electron in dev) as
 * plain Node (ELECTRON_RUN_AS_NODE: Electron's own main process gets no stdin on Windows) on the bundled server, with
 * this app's data folder. The script sits inside app.asar in the installed app; Electron reads it from there.
 */
export function clientConfig(dataDir: string): string {
  const server = path.join(__dirname, "../../mcp/server.js");
  const env = { ELECTRON_RUN_AS_NODE: "1", BOAR_USER_DATA: dataDir };
  return JSON.stringify({ mcpServers: { boar: { command: process.execPath, args: [server], env } } }, null, 2);
}

export function register(ctx: HandlerContext): void {
  const dataDir = path.dirname(ctx.roots.document);
  ctx.ipcMain.handle("library-share:get", () => readConfig(dataDir));
  ctx.ipcMain.handle("library-share:set", (_e, value: unknown) => {
    const config = parseConfig(value);
    writeFileSync(configFile(dataDir), JSON.stringify(config, null, 2));
    return config;
  });
  ctx.ipcMain.handle("library-share:clientConfig", () => clientConfig(dataDir));
}
