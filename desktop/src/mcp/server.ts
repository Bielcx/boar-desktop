/**
 * BOAR's MCP server: other AI apps (Claude Desktop, Cursor...) search the user's offline library and get passages
 * with their source. No model answers here, only the app's own search (src/rag/retrieve.ts), on the same data the app
 * uses, opened read-only. stdio is the only channel. Built into dist/mcp/server.js by scripts/build-mcp.mjs (the engine
 * is the app's src/ code on the desktop shims, the way bench/docs.run.ts runs it). Notes: docs/09-mcp.md.
 *
 *   ELECTRON_RUN_AS_NODE=1 BOAR.exe <app.asar>/dist/mcp/server.js     what the client runs (handlers/library-share.ts)
 *   node dist/mcp/server.js                                            the same with Node (tests)
 * Data folder: BOAR_USER_DATA, else the app's default (%APPDATA%\BOAR on Windows).
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { loopback } from "../testing/loopback";
import { register as sqlite } from "../main/handlers/expo-sqlite";
import { register as fsLegacy } from "../main/handlers/expo-file-system-legacy";
import { register as llama } from "../main/handlers/llama.rn";
import { readConfig, type LibraryShareConfig } from "../main/handlers/library-share";
import type { HandlerContext } from "../main/handlers/context";
import { handleLine, type Tool } from "./protocol";

const VERSION = "0.1.0";
/** Every channel the search needs, all of them reads. Any other one isn't even registered. */
const READ_CHANNELS = new Set([
  "expo-sqlite:open",
  "expo-sqlite:exec", // db.ts's CREATE ... IF NOT EXISTS: a no-op on a read-only connection to an existing library
  "expo-sqlite:all",
  "expo-sqlite:first",
  "expo-sqlite:close",
  "expo-file-system-legacy:getInfoAsync",
  "expo-file-system-legacy:readAsStringAsync",
  "expo-file-system-legacy:readDirectoryAsync",
  "llama.rn:initLlama",
  "llama.rn:embedding",
  "llama.rn:release",
  "llama.rn:releaseAll",
  "llama.rn:getBackendDevicesInfo",
]);
const MAX_K = 20;
const MAX_QUERY = 2000;
const BUILTIN = { id: "builtin", name: "Built-in library (bundled articles and downloaded knowledge packs)" };

/** Electron's userData for the app named BOAR. */
export function defaultDataDir(): string {
  if (process.env.BOAR_USER_DATA) return path.resolve(process.env.BOAR_USER_DATA);
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "BOAR");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "BOAR");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "BOAR");
}

/** The search engine on `dataDir`, started on first use (the embedding model takes a second to load). */
function engine(dataDir: string) {
  let ready: Promise<typeof import("../../../src/rag/retrieve")> | null = null;
  const start = async () => {
    if (!existsSync(path.join(dataDir, "documents"))) {
      throw new Error(`No BOAR library at ${dataDir}. Open BOAR once and finish its setup.`);
    }
    const { native, ctx } = loopback(dataDir);
    const readOnly: HandlerContext = {
      ...ctx,
      readOnly: true,
      ipcMain: { handle: (channel, fn) => void (READ_CHANNELS.has(channel) && ctx.ipcMain.handle(channel, fn)) },
    };
    for (const register of [sqlite, fsLegacy, llama]) register(readOnly);
    (globalThis as any).window = { boarNative: native };
    // After window: the shims read the data folders when they load.
    const [{ getActiveModelId }, { MODEL_CATALOG, REQUIRED_MODELS }, { embeddingEngine }, retrieve] = await Promise.all([
      import("../../../src/models/settings"),
      import("../../../src/models/manifest"),
      import("../../../src/rag/embed"),
      import("../../../src/rag/retrieve"),
    ]);
    // The embedder the library was indexed with (ChatScreen's resolveActiveModel, without the Hugging Face extras).
    const id = await getActiveModelId("embedding");
    const emb = MODEL_CATALOG.find((m) => m.kind === "embedding" && m.id === id) ?? REQUIRED_MODELS.find((m) => m.kind === "embedding")!;
    await embeddingEngine.load(emb.filename);
    return retrieve;
  };
  return () => {
    ready ??= start().catch((e) => {
      ready = null; // a later call tries again (e.g. after the user finishes setup)
      throw e;
    });
    return ready;
  };
}

async function collections(): Promise<Array<{ id: string; name: string; docCount: number }>> {
  const { listCustomCollections } = await import("../../../src/rag/db");
  return (await listCustomCollections()).map((c) => ({ id: c.id, name: c.name, docCount: c.docCount }));
}

/** The two tools, on the library at `dataDir`. The config is read on every call: Settings changes apply at once. */
export function libraryTools(dataDir: string, config: () => LibraryShareConfig = () => readConfig(dataDir)): Tool[] {
  const load = engine(dataDir);
  const shared = async () => {
    const c = config();
    if (!c.enabled) {
      throw new Error("Library sharing is off. Turn on \"Share my library with other apps (MCP)\" in BOAR's Settings.");
    }
    await load();
    const visible = (await collections()).filter((x) => c.collections.includes(x.id));
    return { builtin: c.builtin, visible };
  };

  return [
    {
      name: "list_collections",
      description: "Lists the collections of the user's offline BOAR library that this app may search.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async call() {
        const { builtin, visible } = await shared();
        const list = [...visible.map((c) => ({ ...c, kind: "personal" })), ...(builtin ? [{ ...BUILTIN, kind: "builtin" }] : [])];
        return { text: JSON.stringify(list, null, 2), structured: { collections: list } };
      },
    },
    {
      name: "search_library",
      description:
        "Searches the user's offline BOAR library (their own imported documents first, then bundled and Wikipedia " +
        "articles) and returns the most relevant passages, each with its title, source and collection. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in natural language (English or Portuguese)." },
          k: { type: "integer", minimum: 1, maximum: MAX_K, description: "How many passages (default 6)." },
          collections: {
            type: "array",
            items: { type: "string" },
            description: "Only these collections (ids or names from list_collections). Default: all shared ones.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async call(args) {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) throw new Error("query must be a non-empty string");
        if (query.length > MAX_QUERY) throw new Error(`query is longer than ${MAX_QUERY} characters`);
        const k = args.k === undefined ? 6 : Number(args.k);
        if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new Error(`k must be an integer from 1 to ${MAX_K}`);
        const { builtin, visible } = await shared();
        let scope = { collections: visible.map((c) => c.id), builtin };
        if (args.collections !== undefined) {
          if (!Array.isArray(args.collections)) throw new Error("collections must be an array of strings");
          const wanted = args.collections.map(String);
          const pick = (w: string) => (builtin && (w === BUILTIN.id || w === BUILTIN.name) ? BUILTIN : visible.find((c) => c.id === w || c.name === w));
          const unknown = wanted.filter((w) => !pick(w));
          if (unknown.length) throw new Error(`Not a shared collection: ${unknown.join(", ")}. See list_collections.`);
          const picked = wanted.map(pick);
          scope = { collections: visible.filter((c) => picked.includes(c)).map((c) => c.id), builtin: picked.includes(BUILTIN) };
        }
        const { retrieve } = await load();
        const hits = await retrieve(query, k, { scope });
        const names = new Map(visible.map((c) => [c.id, c.name]));
        const results = hits.map((h) => ({
          title: h.title,
          source: h.source ?? "",
          collection: h.collectionId ? (names.get(h.collectionId) ?? h.collectionId) : "Built-in library",
          similarity: h.similarity === undefined ? null : Math.round(h.similarity * 1000) / 1000,
          text: h.body,
        }));
        const text = results.length
          ? JSON.stringify(results, null, 2)
          : "Nothing in the shared library matches this question closely enough.";
        return { text, structured: { results } };
      },
    },
  ];
}

/** Serves MCP on stdin/stdout until stdin closes. stdout carries only protocol messages; every log goes to stderr. */
export function runMcpServer(dataDir = defaultDataDir()): Promise<void> {
  const write = process.stdout.write.bind(process.stdout);
  // Anything else that prints (the engine's console.log, a library) would corrupt the protocol: it goes to stderr.
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  console.log = console.info = console.debug = console.warn = console.error;
  const tools = libraryTools(dataDir);
  console.error(`[boar-mcp] serving the library at ${dataDir}`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    void handleLine(line, tools, { name: "boar", version: VERSION }).then((res) => {
      if (res) write(JSON.stringify(res) + "\n");
    });
  });
  return new Promise((resolve) => rl.on("close", resolve));
}

// Run as a script (the client's command); importing it (tests) only gets the functions.
if (require.main === module) {
  void runMcpServer().then(() => process.exit(0));
}
