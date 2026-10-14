// Build-time client for Jev (typesafe-ai/jev on the Vercel AI Gateway): calibrated
// yes/no answers for bulk checks while building packs. Never used by the app.
//
// Rules (Boar HQ, "Segredos"): key only from VERCEL_AI_GATEWAY; every response
// cached on disk by request hash (deterministic model, so a re-run is free);
// every paid call's cost appended to shared-data/jev-spend.jsonl; a per-task
// budget stops the job before it's exceeded.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHARED = process.env.BOAR_SHARED_DATA ?? "/Users/r4to/Script/boar/shared-data";
const CACHE = join(SHARED, "jev-cache");
const SPEND = join(SHARED, "jev-spend.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Total spent so far by this owner and task, from the spend log. */
export function spentUsd(task, owner = "Bramble") {
  if (!existsSync(SPEND)) return 0;
  return readFileSync(SPEND, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.owner === owner && r.task === task)
    .reduce((s, r) => s + Number(r.marketCost || 0), 0);
}

/**
 * One /v1/evaluate request; cached. `task` and `budgetUsd` guard the spend:
 * throws before a paid call once the task's logged spend reaches the budget.
 */
export async function evaluate(state, questions, { task, budgetUsd }) {
  const body = JSON.stringify({ model: "typesafe-ai/jev", state, questions });
  const hash = createHash("sha256").update(body).digest("hex");
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${hash}.json`);
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, "utf8")), cached: true };
  if (spentUsd(task) >= budgetUsd) throw new Error(`Jev budget for "${task}" reached (US$${budgetUsd})`);
  const key = process.env.VERCEL_AI_GATEWAY;
  if (!key) throw new Error("VERCEL_AI_GATEWAY is not set");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
    });
    if (res.ok) {
      const j = await res.json();
      writeFileSync(file, JSON.stringify(j));
      appendFileSync(
        SPEND,
        `${JSON.stringify({ at: new Date().toISOString(), owner: "Bramble", task, marketCost: j.providerMetadata?.gateway?.marketCost ?? null, inputTokens: j.usage?.inputTokens ?? null })}\n`
      );
      return j;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(Math.min(8000, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * One boolean per item, `size` items per request, each item inside its own
 * question (never an index into a long array). Returns Map(key → probability).
 * `instructionsFor(item)` builds the question text; items is Map(key → item).
 */
export async function booleanPerItem(items, instructionsFor, { task, budgetUsd, size = 25, onBatch }) {
  const out = new Map();
  const keys = [...items.keys()];
  for (let i = 0; i < keys.length; i += size) {
    const batch = keys.slice(i, i + size);
    const questions = Object.fromEntries(batch.map((k) => [k, { type: "boolean", instructions: instructionsFor(items.get(k)) }]));
    const r = await evaluate({ note: "Each question carries its own item." }, questions, { task, budgetUsd });
    for (const k of batch) out.set(k, r.answers?.[k]?.probability ?? null);
    onBatch?.(i + batch.length, keys.length);
  }
  return out;
}
