// npm run bench -- [--docs [--scoped]] [--quick | --full] [--label name] [--model id] [--ctx n] [--gpu-layers n] [--threads n] [--seed n] [--k n] [--context-tokens n] [--wiki] [--kv f16|q8_0|q4_0] [--repeat n]
// Runs bench/engine.run.ts (the app's engine in Node, no window) and prints the table. Result: bench/results/<date>-<label>-<mode>.json
// Models come from BOAR_TEST_MODELS_DIR (default C:/Users/bielc/Dev/boar-shared-models when it exists).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stability, table } from "./report.mjs";

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
    kv: { type: "string" }, // KV cache type for keys and values (llama.rn's cache_type_k/v)
    repeat: { type: "string" }, // n runs of the same setup, seeds seed..seed+n-1, then the spread and per-question stability
    wiki: { type: "boolean" }, // the main bench with one Wikipedia shard installed (BOAR_TEST_MODELS_DIR/corpus)
    "context-tokens": { type: "string" },
  },
});
const mode = values.full ? "full" : "quick";
const label = values.label.replace(/[^\w.-]+/g, "-");
const outFor = (suffix = "") => path.join(here, "results", `${new Date().toLocaleDateString("sv")}-${label}${suffix}-${values.docs ? (values.scoped ? "docs-scoped" : "docs") : mode}.json`);
const repeat = values.docs ? 1 : Math.max(1, Number(values.repeat) || 1);
const seed0 = Number(values.seed ?? 42);
const fallbackModels = "C:/Users/bielc/Dev/boar-shared-models";

const env = {
  ...process.env,
  BOAR_BENCH_MODE: mode,
  BOAR_BENCH_LABEL: label,
  ...(values.docs ? { BOAR_BENCH_DOCS: "1" } : {}),
  ...(values.scoped ? { BOAR_BENCH_SCOPED: "1" } : {}),
  ...(values.wiki ? { BOAR_BENCH_WIKI: "1" } : {}),
  BOAR_TEST_MODELS_DIR: process.env.BOAR_TEST_MODELS_DIR || (fs.existsSync(fallbackModels) ? fallbackModels : ""),
};
for (const [flag, name] of [["model", "BOAR_BENCH_MODEL"], ["ctx", "BOAR_BENCH_CTX"], ["gpu-layers", "BOAR_GPU_LAYERS"], ["threads", "BOAR_BENCH_THREADS"], ["seed", "BOAR_BENCH_SEED"], ["k", "BOAR_BENCH_K"], ["context-tokens", "BOAR_BENCH_CONTEXT_TOKENS"], ["kv", "BOAR_BENCH_KV"]]) {
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
const all = [];
for (let i = 0; i < repeat; i++) {
  const out = outFor(repeat > 1 ? `-r${i + 1}` : "");
  const runEnv = { ...env, BOAR_BENCH_OUT: out, ...(repeat > 1 ? { BOAR_BENCH_SEED: String(seed0 + i) } : {}) };
  const gpuBefore = gpuState();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [vitest, "run", "--config", "bench/vitest.config.mts"], { cwd: desktop, env: runEnv, stdio: "inherit" });
  if (r.status !== 0 || !fs.existsSync(out)) {
    console.error(`bench failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
  if (values.docs) process.exit(0); // docs.run.ts prints its own summary
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  Object.assign(result.meta, { gpuBefore, gpuAfter: gpuState(), wallSeconds: Math.round((Date.now() - t0) / 1000) });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  all.push(result);
  console.log(`\n${table([result])}`);
  console.log(`\n${path.relative(desktop, out)} · ${result.meta.wallSeconds} s`);
}
if (all.length > 1) {
  console.log(`\n${table(all)}`);
  if (all.length > 2) console.log(`\n${stability(all)}`);
}
