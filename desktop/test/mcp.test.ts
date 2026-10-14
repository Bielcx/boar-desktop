/**
 * The MCP server (src/mcp/, docs/09-mcp.md). The protocol message by message, then the real server as a child process
 * (`node dist/mcp/server.js`, the bundle `BOAR.exe --mcp` runs) on a library with two imported documents: initialize ->
 * tools/list -> tools/call. The second part needs the embedding model (BOAR_TEST_MODELS_DIR, embedding.gguf); skipped
 * without it. BOAR_MCP_EXE=release/win-unpacked/BOAR.exe runs the packaged app's server instead, the way Claude Desktop
 * does: the exe as Node (ELECTRON_RUN_AS_NODE) on dist/mcp/server.js inside app.asar.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleLine, PROTOCOL_VERSIONS, type Tool } from "../src/mcp/protocol";
import { parseConfig } from "../src/main/handlers/library-share";
import { setupDesktop } from "./setup";
import { register as llamaHandlers } from "../src/main/handlers/llama.rn";
import { createHash } from "node:crypto";

vi.mock("expo-sqlite", () => import("../src/shims/expo-sqlite"));
vi.mock("expo-file-system", () => import("../src/shims/expo-file-system"));
vi.mock("expo-file-system/legacy", () => import("../src/shims/expo-file-system-legacy"));
vi.mock("file-hash", () => import("../src/shims/file-hash"));
vi.mock("ram-monitor", () => import("../src/shims/ram-monitor"));
vi.mock("expo-pdf-text-extract", () => import("../src/shims/expo-pdf-text-extract"));
vi.mock("expo-document-picker", () => import("../src/shims/expo-document-picker"));
vi.mock("expo-sharing", () => import("../src/shims/expo-sharing"));
vi.mock("offline-location", () => import("../src/shims/offline-location"));
vi.mock("download-wake-lock", () => import("../src/shims/download-wake-lock"));
vi.mock("device-key", () => import("../src/shims/device-key"));
vi.mock("voice-input", () => import("../src/shims/voice-input"));
vi.mock("bundled-assets", () => ({ excludeFromBackup: async () => {} }));
vi.mock("llama.rn", () => import("../src/shims/llama.rn"));
vi.mock("react-native", () => ({ Platform: { OS: "web", select: (o: any) => o.web ?? o.default } }));

const SERVER = { name: "boar", version: "test" };
const echo: Tool = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object" },
  call: async (args) => {
    if (args.fail) throw new Error("it failed");
    return { text: String(args.text), structured: { text: args.text } };
  },
};
const send = (msg: unknown) => handleLine(JSON.stringify(msg), [echo], SERVER);

describe("MCP protocol", () => {
  it("initialize: echoes a version it knows, offers its newest otherwise", async () => {
    const r = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(r).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: SERVER } });
    const newer = await send({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2099-01-01" } });
    expect((newer as any).result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("notifications get no answer; ping, tools/list and tools/call do", async () => {
    expect(await send({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await send({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await send({ jsonrpc: "2.0", id: 3, method: "tools/list" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] },
    });
    expect(await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } })).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { content: [{ type: "text", text: "hi" }], structuredContent: { text: "hi" }, isError: false },
    });
  });

  it("a failing tool is a tool error the model can read; protocol mistakes are JSON-RPC errors", async () => {
    const failed = await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: { fail: true } } });
    expect(failed).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "it failed" }], isError: true } });
    expect((await send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "rm" } }))!.error!.code).toBe(-32602);
    expect((await send({ jsonrpc: "2.0", id: 7, method: "resources/list" }))!.error!.code).toBe(-32601);
    expect((await handleLine("{not json", [echo], SERVER))!.error!.code).toBe(-32700);
    expect((await send({ id: 8, method: "ping" }))!.error).toMatchObject({ code: -32600 });
    // A response from the client (we never ask it anything) is ignored.
    expect(await send({ jsonrpc: "2.0", id: 9, result: {} })).toBeNull();
  });

  it("the settings file: anything odd reads as off", () => {
    expect(parseConfig(null)).toEqual({ enabled: false, collections: [], builtin: true });
    expect(parseConfig({ enabled: "yes", collections: ["a", 3, "a", ""], builtin: 0 })).toEqual({ enabled: false, collections: ["a"], builtin: true });
    expect(parseConfig({ enabled: true, collections: ["x"], builtin: false })).toEqual({ enabled: true, collections: ["x"], builtin: false });
  });
});

const MODELS = process.env.BOAR_TEST_MODELS_DIR ?? "";
const EMB = "embedding.gguf";
const haveEmbedder = !!MODELS && fs.existsSync(path.join(MODELS, EMB));
const desktop = path.join(__dirname, "..");
const T = 120_000;

/** A minimal MCP client over the child's stdio. */
function client(child: ChildProcess) {
  const waiting = new Map<number, (r: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const msg = JSON.parse(line); // every stdout line must be protocol JSON
    waiting.get(msg.id)?.(msg);
  });
  let next = 0;
  return {
    request: (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
      }),
    notify: (method: string) => child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"),
  };
}

describe.skipIf(!haveEmbedder)("MCP server as a child process", () => {
  let env: ReturnType<typeof setupDesktop>;
  let child: ChildProcess;
  let mcp: ReturnType<typeof client>;
  let stderr = "";
  const ids: Record<string, string> = {};
  let before = "";
  const libraryHash = () => {
    const dir = path.join(env.dataDir, "documents", "SQLite");
    const h = createHash("sha256");
    for (const f of fs.readdirSync(dir).filter((f) => !f.endsWith("-shm")).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
    return h.digest("hex");
  };
  const writeConfig = (c: object) => fs.writeFileSync(path.join(env.dataDir, "mcp.json"), JSON.stringify(c));

  beforeAll(async () => {
    const built = spawnSync(process.execPath, ["scripts/build-mcp.mjs"], { cwd: desktop, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);

    // A library as the app leaves it: the embedder in documents/models, two documents imported as two collections.
    env = setupDesktop();
    llamaHandlers(env.ctx);
    const documents = path.join(env.dataDir, "documents");
    fs.mkdirSync(path.join(documents, "models"), { recursive: true });
    fs.linkSync(path.join(MODELS, EMB), path.join(documents, "models", EMB));
    const { embeddingEngine } = await import("../../src/rag/embed");
    const { importDocuments } = await import("../../src/services/documentImporter");
    await embeddingEngine.load(`models/${EMB}`);
    const docs = {
      Recipes: ["grandma-recipes.txt", "Grandma Zuleica's cornmeal cake needs three eggs, two cups of cornmeal and a cup of milk. Bake it for 40 minutes at 180 degrees."],
      Secret: ["safe.txt", "The office safe combination is 12-34-56. Never share the safe combination with anyone."],
    };
    for (const [name, [file, text]] of Object.entries(docs)) {
      const p = path.join(env.dataDir, "app-cache", file);
      fs.writeFileSync(p, text);
      ids[name] = (await importDocuments([{ uri: pathToFileURL(p).href, name: file, size: text.length, mimeType: "text/plain" } as any], name)).id;
    }
    await embeddingEngine.unload();
    before = libraryHash();

    const exe = process.env.BOAR_MCP_EXE && path.resolve(desktop, process.env.BOAR_MCP_EXE);
    child = exe
      ? spawn(exe, [path.join(path.dirname(exe), "resources", "app.asar", "dist", "mcp", "server.js")], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", BOAR_USER_DATA: env.dataDir },
          stdio: "pipe",
        })
      : spawn(process.execPath, ["dist/mcp/server.js"], { cwd: desktop, env: { ...process.env, BOAR_USER_DATA: env.dataDir }, stdio: "pipe" });
    child.stderr!.on("data", (d) => (stderr += d));
    mcp = client(child);
  }, T);

  afterAll(async () => {
    child?.stdin?.end();
    if (child && child.exitCode === null) await new Promise((r) => child.once("exit", r));
    try {
      await (await (await import("../../src/rag/db")).getDb()).closeAsync();
    } catch {}
    try {
      fs.rmSync(env.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {} // Windows: a file the GPU driver still maps; the OS temp cleaner gets it
  });

  it("initialize, tools/list, then search_library finds the shared document with its source", async () => {
    const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.serverInfo.name).toBe("boar");
    mcp.notify("notifications/initialized");
    const tools = (await mcp.request("tools/list")).result.tools.map((t: any) => t.name);
    expect(tools.sort()).toEqual(["list_collections", "search_library"]);

    // Off (the default): a clear error, nothing from the library.
    const off = await mcp.request("tools/call", { name: "search_library", arguments: { query: "cornmeal cake eggs" } });
    expect(off.result.isError).toBe(true);
    expect(off.result.content[0].text).toMatch(/sharing is off/i);

    writeConfig({ enabled: true, collections: [ids.Recipes], builtin: true });
    const list = await mcp.request("tools/call", { name: "list_collections", arguments: {} });
    expect(list.result.structuredContent.collections.map((c: any) => c.name)).toEqual(["Recipes", expect.stringMatching(/^Built-in/)]);

    const found = await mcp.request("tools/call", { name: "search_library", arguments: { query: "How many eggs go in Grandma Zuleica's cornmeal cake?", k: 4 } });
    expect(found.result.isError).toBe(false);
    const top = found.result.structuredContent.results[0];
    expect(top).toMatchObject({ collection: "Recipes", source: "grandma-recipes.txt" });
    expect(top.text).toMatch(/three eggs/);
    expect(top.similarity).toBeGreaterThan(0.5);
    expect(found.result.content[0].text).toContain("grandma-recipes.txt");
  }, T);

  it("only the collections the user ticked: an unshared one is never searched nor named", async () => {
    writeConfig({ enabled: true, collections: [ids.Recipes], builtin: false });
    const r = await mcp.request("tools/call", { name: "search_library", arguments: { query: "What is the office safe combination?" } });
    expect(JSON.stringify(r.result)).not.toContain("12-34-56");
    const named = await mcp.request("tools/call", { name: "search_library", arguments: { query: "safe combination", collections: ["Secret"] } });
    expect(named.result.isError).toBe(true);
    expect(named.result.content[0].text).toMatch(/Not a shared collection: Secret/);
    const bad = await mcp.request("tools/call", { name: "search_library", arguments: { query: "x", k: 500 } });
    expect(bad.result.isError).toBe(true);

    // Ticked in Settings: found right away, without restarting the server.
    writeConfig({ enabled: true, collections: [ids.Recipes, ids.Secret], builtin: false });
    const now = await mcp.request("tools/call", { name: "search_library", arguments: { query: "What is the office safe combination?", collections: ["Secret"] } });
    expect(now.result.structuredContent.results[0]).toMatchObject({ collection: "Secret", source: "safe.txt" });
  }, T);

  it("never writes the library, and logs only to stderr", async () => {
    // Read-only connection, no write channel at all (READ_CHANNELS in server.ts): the database and its WAL are untouched.
    expect(libraryHash()).toBe(before);
    expect(stderr).toContain("[boar-mcp] serving the library at");
  });
});
