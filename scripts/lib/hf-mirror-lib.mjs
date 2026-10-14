// The public copy of shared scores on Hugging Face. Only what the publishable key can already read
// (eval_scores rows that aren't hidden) is published; nothing here can reach eval_runs, keys or IP
// hashes.

/** The columns published, in order: eval_scores minus its internal id and the hidden flag. */
export const COLUMNS = [
  "run", "received_at", "score_version",
  "platform", "device_brand", "device_model", "soc", "soc_manufacturer",
  "ram_bytes", "cpu_cores", "cpu_max_mhz", "has_i8mm", "has_dotprod",
  "app_version", "eval_set_version",
  "config_id", "model_id", "model_label",
  "answers", "completed", "retrieval_questions", "retrieval_hits",
  "median_tok_per_sec", "median_ttft_ms", "median_total_ms", "peak_rss_bytes",
  "speed", "reliability", "retrieval", "score",
];

/** The PostgREST URL for one page of public scores, oldest first. */
export function scoresPageUrl(supabaseUrl, offset, limit) {
  const q = new URLSearchParams({ select: COLUMNS.join(","), order: "received_at.asc,run.asc,config_id.asc", offset: String(offset), limit: String(limit) });
  return `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/eval_scores?${q}`;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rows as CSV with a header, only the published columns, "\n" line ends. */
export function toCsv(rows) {
  const lines = [COLUMNS.join(",")];
  for (const r of rows) lines.push(COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n") + "\n";
}

/** Rows as JSON Lines, only the published columns. */
export function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? null])))).join("\n") + (rows.length ? "\n" : "");
}

/** The dataset card (README.md with the Hub's YAML header). */
export function datasetCard({ rows, sourceRepo }) {
  const runs = new Set(rows.map((r) => r.run)).size;
  const devices = new Set(rows.map((r) => `${r.device_brand ?? ""} ${r.device_model ?? ""}`)).size;
  return `---
license: cc-by-4.0
pretty_name: BOAR on-device LLM results
tags:
- on-device
- llm
- benchmark
- mobile
- gguf
configs:
- config_name: default
  data_files: scores.csv
---

# BOAR on-device LLM results

How small language models run on real phones: speed, reliability and retrieval, measured by the
[BOAR](https://github.com/${sourceRepo}) app on the phones of people who chose to share a run.

${rows.length} model results from ${runs} runs on ${devices} phone models, copied daily from BOAR's
results database. Only approved results are included.

## Columns

One row per model in a shared run. \`score\` (0-100) and its parts (\`speed\`, \`reliability\`,
\`retrieval\`, 0-1) are defined in [docs/RESULTS_SCORE.md](https://github.com/${sourceRepo}/blob/main/docs/RESULTS_SCORE.md).
The phone columns are its model, chip, RAM and cores; there is nothing about the person who shared
it. \`run\` is a random id grouping the models of one run.

The same rows are in \`scores.csv\` and \`scores.jsonl\`.

## How runs are checked

Each run is signed by a key in the phone's secure hardware and checked by the server; runs that
can't be verified, or look implausible, are reviewed before they appear here. See
[supabase/README.md](https://github.com/${sourceRepo}/blob/main/supabase/README.md).

## License

CC BY 4.0. Please credit "BOAR results (github.com/${sourceRepo})". Removal requests:
privacy@boarapp.com.
`;
}

/** The body of a Hub commit (POST /api/datasets/<repo>/commit/<branch>, NDJSON). */
export function commitBody(summary, files) {
  const lines = [{ key: "header", value: { summary } }];
  for (const [path, content] of Object.entries(files)) {
    lines.push({ key: "file", value: { path, content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" } });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n");
}
