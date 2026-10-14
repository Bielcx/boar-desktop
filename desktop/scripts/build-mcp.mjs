// Bundles the MCP server (src/mcp/server.ts) into dist/mcp/server.js, run by `BOAR.exe --mcp` (docs/09-mcp.md).
// The server is the app's own engine (../src, TypeScript the main build can't compile) on the desktop shims, so native
// packages resolve to src/shims/<pkg>.ts as metro.config.js does for the window. rolldown comes from the repo root's
// node_modules (vite's, via vitest), like vitest itself for npm test: no new dependency.
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import PACKAGES from "../src/shared/packages.json" with { type: "json" };

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shims = path.join(desktop, "src/shims");
const alias = Object.fromEntries(Object.entries(PACKAGES).map(([pkg, file]) => [pkg, path.join(shims, `${file}.ts`)]));
// The engine reads only Platform from react-native (embed.ts: Android-only CPU fallbacks).
const RN = "\0react-native";

await build({
  input: path.join(desktop, "src/mcp/server.ts"),
  platform: "node",
  // Loaded at run time from node_modules (native binaries, asar-unpacked in the package).
  external: [...builtinModules, /^node:/, "electron", "node-llama-cpp", /^@node-llama-cpp\//],
  resolve: { alias },
  plugins: [
    {
      name: "react-native-stub",
      resolveId: (id) => (id === "react-native" ? RN : null),
      load: (id) => (id === RN ? `export const Platform = { OS: "web", select: (o) => o.web ?? o.default };` : null),
    },
  ],
  output: { file: path.join(desktop, "dist/mcp/server.js"), format: "cjs", codeSplitting: false },
  logLevel: "warn",
});
console.log("dist/mcp/server.js");
