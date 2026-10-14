// Tiny cross-platform launcher (instead of cross-env + concurrently).
//   node scripts/run.mjs build-web   expo export --platform web (BOAR_TARGET=desktop) -> desktop/web-dist
//   node scripts/run.mjs dev         Expo dev server (BOAR_TARGET=desktop) + tsc + Electron on http://localhost:8081
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(desktop);
const env = { ...process.env, BOAR_TARGET: "desktop" };
const opts = (cwd, extra = {}) => ({ cwd, env: { ...env, ...extra }, stdio: "inherit", shell: process.platform === "win32" });

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, opts(cwd));
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const mode = process.argv[2];
if (mode === "build-web") {
  run("npx", ["expo", "export", "--platform", "web", "--output-dir", path.join(desktop, "web-dist"), "--clear"], root);
} else if (mode === "dev") {
  const PORT = 8081;
  run("npx", ["tsc", "-p", "tsconfig.json"], desktop);
  // No --web: Metro serves the web app at the root anyway, and Electron (not a browser tab) is the client.
  const expo = spawn("npx", ["expo", "start", "--port", String(PORT)], opts(root));
  const url = `http://localhost:${PORT}`;
  for (let i = 0; ; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    if (i > 120) throw new Error(`Expo dev server didn't answer on ${url}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const electron = spawn("npx", ["electron", "."], opts(desktop, { BOAR_DEV_URL: url }));
  const stop = () => {
    // ponytail: shell:true on Windows means expo.kill hits the shell, not Metro; taskkill /T takes the tree.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(expo.pid), "/T", "/F"]);
    else expo.kill();
  };
  electron.on("exit", (code) => {
    stop();
    process.exit(code ?? 0);
  });
  process.on("SIGINT", stop);
} else {
  console.error("usage: node scripts/run.mjs build-web|dev");
  process.exit(1);
}
