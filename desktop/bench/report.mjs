// Table and comparison for bench result files (desktop/bench/results/*.json).
//   node bench/report.mjs a.json              one result
//   node bench/report.mjs a.json b.json       b vs a, with the change in %
//   node bench/report.mjs a.json b.json c.json ...   side by side, with the spread (CV %) across them: the noise,
//                                                    and each fact question's passes across the runs (stability)
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** [label, getter, unit, which way is better] */
const METRICS = [
  ["Speed", null],
  ["LLM load", (r) => r.speed.llmLoadMs, "ms", "low"],
  ["Embedding load", (r) => r.speed.embedLoadMs, "ms", "low"],
  ["Index corpus", (r) => r.speed.indexMs, "ms", "low"],
  ["Decode (micro)", (r) => r.speed.decodeTokPerSec, "tok/s", "high"],
  ["Prefill (micro)", (r) => r.speed.prefillTokPerSec, "tok/s", "high"],
  ["Prefill ~1.5k tok", (r) => r.speed.prefillMs, "ms", "low"],
  ["TTFT (micro)", (r) => r.speed.microTtftMs, "ms", "low"],
  ["Answer TTFT p50", (r) => r.speed.answerTtftMs, "ms", "low"],
  ["Answer total p50", (r) => r.speed.answerTotalMs, "ms", "low"],
  ["Answer decode p50", (r) => r.speed.answerTokPerSec, "tok/s", "high"],
  ["Answer prefill p50", (r) => r.speed.answerPrefillMs, "ms", "low"],
  ["Memory", null],
  ["Peak RAM (RSS)", (r) => r.memory.peakRssMB, "MB", "low"],
  ["VRAM taken by LLM load", (r) => r.memory.vramAfterLoadMB - r.memory.vramBaseMB, "MB", "low"],
  // Device-wide (all GPUs node-llama-cpp sees, all processes): other apps on the GPU show up here.
  ["Peak VRAM (device)", (r) => r.memory.peakVramMB, "MB", "low"],
  ["Retrieval", null],
  ["hit@k (all expected)", (r) => r.retrieval.hitAtK, "", "high"],
  ["recall@k", (r) => r.retrieval.recallAtK, "", "high"],
  ["MRR", (r) => r.retrieval.mrr, "", "high"],
  ["hit@1", (r) => r.retrieval.hitAt1, "", "high"],
  ["negatives empty", (r) => r.retrieval.negativesEmpty, "", "high"],
  ["retrieve p50", (r) => r.retrieval.medianMs, "ms", "low"],
  ["Quality", null],
  ["Score v1 (0-100)", (r) => r.quality.scoreV1, "", "high"],
  ["Completed", (r) => r.quality.completed, "/n", "high"],
  ["Declined", (r) => r.quality.declined, "", "low"],
  ["Facts passed", (r) => r.quality.factsPassed, "", "high"],
  ["Facts rate", (r) => r.quality.factsRate, "", "high"],
  // Full mode adds bench-only questions (must-decline, Portuguese): see EXTRA_SET in engine.run.ts.
  ["False declines", (r) => r.quality.falseDeclines, "", "low"],
  ["  of should-answer", (r) => r.quality.shouldAnswer, "", ""],
  ["False answers", (r) => r.quality.falseAnswers, "", "low"],
  ["  of should-decline", (r) => r.quality.shouldDecline, "", ""],
  ["Wrong answers (facts)", (r) => r.quality.wrongAnswers, "", "low"],
];

const fmt = (v) => (v === undefined || v === null ? "-" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v));
const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const lpad = (s, n) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

export function table(results) {
  const n = results.length;
  const head = results.map((r) => `${r.meta.label} (${r.meta.mode})`);
  const lastHead = n === 2 ? "change" : n > 2 ? "CV %" : "";
  const w = Math.max(14, ...head.map((h) => h.length + 1));
  const lines = [];
  lines.push(pad("", 24) + head.map((h) => lpad(h, w)).join("") + (lastHead ? lpad(lastHead, 12) : ""));
  for (const [label, get, unit, better] of METRICS) {
    if (!get) {
      lines.push(`-- ${label}`);
      continue;
    }
    const vals = results.map((r) => {
      try {
        return get(r);
      } catch {
        return undefined;
      }
    });
    let extra = "";
    const nums = vals.filter((v) => typeof v === "number");
    if (n === 2 && nums.length === 2) {
      const [a, b] = vals;
      const d = a === 0 ? (b === 0 ? 0 : Infinity) : ((b - a) / Math.abs(a)) * 100;
      const good = d === 0 ? "" : (d > 0) === (better === "high") ? " +" : " -";
      extra = lpad(`${d > 0 ? "+" : ""}${d.toFixed(1)}%${good}`, 12);
    } else if (n > 2 && nums.length === n) {
      const mean = nums.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
      extra = lpad(mean ? ((sd / Math.abs(mean)) * 100).toFixed(1) : "0.0", 12);
    }
    const u = unit === "/n" ? `/${results[0].quality.answers}` : unit;
    lines.push(pad(`  ${label}${u ? ` (${u})` : ""}`, 24) + vals.map((v) => lpad(fmt(v), w)).join("") + extra);
  }
  const m = results[0].meta;
  const b = m.backend ?? {};
  lines.push("");
  lines.push(
    `model ${m.model} · n_ctx ${m.nCtx} · threads ${m.threads} · gpu layers ${m.gpuLayers} · ${b.gpu ? `GPU ${(b.devices ?? []).join(", ")}` : `CPU (${b.reasonNoGPU ?? "?"})`} · seed ${m.seed} · ${m.commit}`
  );
  const temps = results.map((r) => (r.meta.gpuBefore ? `${r.meta.gpuBefore.tempC}->${r.meta.gpuAfter?.tempC}°C` : "-"));
  if (temps.some((t) => t !== "-")) lines.push(`GPU temperature before->after: ${temps.join(" | ")}`);
  if (n === 2) lines.push("change: + = better, - = worse. Check it against the noise (CV %) in bench.md before calling it real.");
  return lines.join("\n");
}

/**
 * Each fact-checked question's passes across runs of the same setup: "0/3" is a question the model gets wrong,
 * "1/3" or "2/3" is noise (GPU timing, sampling). The facts rate's range says how big a change must be to count.
 */
export function stability(results) {
  const n = results.length;
  const passes = new Map();
  for (const r of results) for (const a of r.answers ?? []) {
    if (typeof a.fact !== "boolean") continue;
    passes.set(a.id, (passes.get(a.id) ?? 0) + (a.fact ? 1 : 0));
  }
  const rates = results.map((r) => r.quality?.factsRate).filter((v) => typeof v === "number");
  const always = [...passes].filter(([, k]) => k === n).map(([id]) => id);
  const never = [...passes].filter(([, k]) => k === 0).map(([id]) => id);
  const flaky = [...passes].filter(([, k]) => k > 0 && k < n).map(([id, k]) => `${id} ${k}/${n}`);
  const mean = rates.reduce((a, b) => a + b, 0) / (rates.length || 1);
  return [
    `-- Stability across ${n} runs (${passes.size} fact-checked questions)`,
    `  facts rate: mean ${mean.toFixed(3)}, range ${Math.min(...rates).toFixed(3)}-${Math.max(...rates).toFixed(3)}`,
    `  right every run: ${always.length}`,
    `  wrong every run (the model): ${never.length ? never.join(", ") : "none"}`,
    `  sometimes (noise): ${flaky.length ? flaky.join(", ") : "none"}`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: npm run bench:compare -- a.json [b.json ...]");
    process.exit(2);
  }
  const results = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  console.log(table(results));
  if (results.length > 2) console.log(`\n${stability(results)}`);
}
