// npm run bench -- [--docs [--scoped]] [--quick | --full] [--label name] [--model id] [--ctx n] [--gpu-layers n] [--threads n] [--seed n] [--k n] [--context-tokens n] [--wiki]
// Runs bench/engine.run.ts (the app's engine in Node, no window) and prints the table. Result: bench/results/<date>-<label>-<mode>.json
// Models come from BOAR_TEST_MODELS_DIR (default C:/Users/bielc/Dev/boar-shared-models when it exists).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { table } from "./report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.dirname(here);
const { values } = parseArgs({
  options: {
    quick: { type: "boolean" },
    full: { type: "boolean" },
    docs: { type: "boolean" }, // bench/docs.run.ts: personal documents next to a Wikipedia pack
    scoped: { type: "boolean" }, // with --docs: each question limited to its document ("Ask this document")
    label: { type: "string", default: "run" },
    model: { type: "string" },
    ctx: { type: "string" },
    "gpu-layers": { type: "string" },
    threads: { type: "string" },
    seed: { type: "string" },
    k: { type: "string" },
    wiki: { type: "boolean" }, // the main bench with one Wikipedia shard installed (BOAR_TEST_MODELS_DIR/corpus)
    "context-tokens": { type: "string" },
  },
});
const mode = values.full ? "full" : "quick";
const label = values.label.replace(/[^\w.-]+/g, "-");
const out = path.join(here, "results", `${new Date().toLocaleDateString("sv")}-${label}-${values.docs ? (values.scoped ? "docs-scoped" : "docs") : mode}.json`);
const fallbackModels = "C:/Users/bielc/Dev/boar-shared-models";

const env = {
  ...process.env,
  BOAR_BENCH_MODE: mode,
  BOAR_BENCH_LABEL: label,
  BOAR_BENCH_OUT: out,
  ...(values.docs ? { BOAR_BENCH_DOCS: "1" } : {}),
  ...(values.scoped ? { BOAR_BENCH_SCOPED: "1" } : {}),
  ...(values.wiki ? { BOAR_BENCH_WIKI: "1" } : {}),
  BOAR_TEST_MODELS_DIR: process.env.BOAR_TEST_MODELS_DIR || (fs.existsSync(fallbackModels) ? fallbackModels : ""),
};
for (const [flag, name] of [["model", "BOAR_BENCH_MODEL"], ["ctx", "BOAR_BENCH_CTX"], ["gpu-layers", "BOAR_GPU_LAYERS"], ["threads", "BOAR_BENCH_THREADS"], ["seed", "BOAR_BENCH_SEED"], ["k", "BOAR_BENCH_K"], ["context-tokens", "BOAR_BENCH_CONTEXT_TOKENS"]]) {
  if (values[flag] !== undefined) env[name] = values[flag];
}

// vitest lives in the repo root's node_modules (as for npm test here).
const vitest = path.join(desktop, "..", "node_modules", "vitest", "vitest.mjs");
// GPU temperature and clock before/after: a laptop GPU throttles when hot, a big source of noise. Optional (NVIDIA only).
const gpuState = () => {
  const q = spawnSync("nvidia-smi", ["--query-gpu=temperature.gpu,clocks.sm,utilization.gpu", "--format=csv,noheader,nounits"], { encoding: "utf8" });
  const [tempC, smClockMHz, utilPct] = (q.stdout ?? "").trim().split(/,\s*/).map(Number);
  return q.status === 0 ? { tempC, smClockMHz, utilPct } : undefined;
};
const gpuBefore = gpuState();
const t0 = Date.now();
const r = spawnSync(process.execPath, [vitest, "run", "--config", "bench/vitest.config.mts"], { cwd: desktop, env, stdio: "inherit" });
if (r.status !== 0 || !fs.existsSync(out)) {
  console.error(`bench failed (exit ${r.status})`);
  process.exit(r.status || 1);
}
if (values.docs) process.exit(0); // docs.run.ts prints its own summary
const result = JSON.parse(fs.readFileSync(out, "utf8"));
Object.assign(result.meta, { gpuBefore, gpuAfter: gpuState(), wallSeconds: Math.round((Date.now() - t0) / 1000) });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`\n${table([result])}`);
console.log(`\n${path.relative(desktop, out)} · ${result.meta.wallSeconds} s`);
