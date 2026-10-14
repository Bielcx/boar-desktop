import { describe, it, expect } from "vitest";
import { COLUMNS, commitBody, datasetCard, scoresPageUrl, toCsv, toJsonl } from "./hf-mirror-lib.mjs";

const row = {
  id: 7, hidden: false, run: "r1", received_at: "2026-09-30T12:00:00Z", score_version: 1,
  platform: "android", device_brand: "POCO", device_model: 'F3, "5G"', soc: "SM8250",
  config_id: "qwen", model_id: "qwen2.5-1.5b", score: 71,
};

describe("hf mirror", () => {
  it("asks only for the published columns, never the id or hidden flag", () => {
    const url = new URL(scoresPageUrl("https://x.supabase.co/", 1000, 1000));
    expect(url.pathname).toBe("/rest/v1/eval_scores");
    expect(url.searchParams.get("select")).toBe(COLUMNS.join(","));
    expect(COLUMNS).not.toContain("hidden");
    expect(COLUMNS).not.toContain("id");
    expect(url.searchParams.get("offset")).toBe("1000");
  });

  it("writes CSV with quoting and empty cells for nulls, and drops unpublished fields", () => {
    const csv = toCsv([row]);
    const [header, line] = csv.trimEnd().split("\n");
    expect(header).toBe(COLUMNS.join(","));
    expect(line).toContain('"F3, ""5G"""');
    expect(line.split(",").length).toBeGreaterThan(COLUMNS.length - 1);
    expect(csv).not.toContain("hidden");
  });

  it("writes JSONL with every published column and nothing else", () => {
    const obj = JSON.parse(toJsonl([row]));
    expect(Object.keys(obj)).toEqual(COLUMNS);
    expect(obj.ram_bytes).toBeNull();
    expect(toJsonl([])).toBe("");
  });

  it("counts runs and phone models in the card", () => {
    const card = datasetCard({ rows: [row, { ...row, config_id: "phi" }], sourceRepo: "o/r" });
    expect(card).toMatch(/^---\nlicense: cc-by-4.0/);
    expect(card).toContain("2 model results from 1 runs on 1 phone models");
  });

  it("builds an NDJSON commit with a header and base64 files", () => {
    const [header, file] = commitBody("s", { "a.csv": "é" }).split("\n").map((l) => JSON.parse(l));
    expect(header).toEqual({ key: "header", value: { summary: "s" } });
    expect(Buffer.from(file.value.content, "base64").toString("utf8")).toBe("é");
    expect(file.value).toMatchObject({ path: "a.csv", encoding: "base64" });
  });
});
