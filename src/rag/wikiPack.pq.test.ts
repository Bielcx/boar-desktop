/// <reference types="node" />
/**
 * Regression for the question Vitalik asked on camera, "Which signature
 * algorithms are quantum resistant?", which the app answered from RSA sources:
 * the bundled corpus has no post-quantum article, the lexical gate dropped
 * every candidate, and a loose semantic floor let "Public-key cryptography"
 * (RSA) through.
 *
 * Here the pack holds the real Wikipedia articles on the topic next to the
 * classic-crypto ones they compete with (src/rag/testing/fixtures/pq-wiki.jsonl:
 * 19 articles fetched from en.wikipedia.org on 2026-09-26, CC BY-SA 4.0,
 * test-only; the app never ships this file).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompress } from "fzstd";
import { nodeSqliteDatabase } from "./testing/nodeSqlite";
import { WikiPack, prefixOf } from "./wikiPack";
import { selectSentences } from "./passages.pure";

let pack: WikiPack;
const PQ = /\b(ML-DSA|SLH-DSA|FN-DSA|Dilithium|Falcon|SPHINCS\+?|XMSS|Merkle signature)/;

beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "boar-pq-")), "pq.sqlite");
  execFileSync(process.execPath, [
    "scripts/build-wiki-pack.mjs", "--out", out, "--no-embed",
    "--shards", "src/rag/testing/fixtures/pq-wiki.jsonl", "src/rag/testing/fixtures/mini-wiki.jsonl",
  ], { stdio: "pipe" });
  pack = await WikiPack.open(nodeSqliteDatabase(out), decompress);
}, 60000);

async function topSentences(query: string, k = 3) {
  const { hits, stems } = await pack.searchDetailed(query, { k: 6 });
  const terms = stems.map((s) => ({ prefixes: [prefixOf(s.stem)], weight: s.idf }));
  return hits.slice(0, k).map((h) => ({ title: h.title, text: selectSentences(h.text, terms, 3, h.lead).map((s) => s.text).join(" ") }));
}

describe("post-quantum signatures", () => {
  it("answers Vitalik's question from post-quantum sources, not RSA", async () => {
    const top = await topSentences("Which signature algorithms are quantum resistant?");
    expect(top.map((t) => t.title)).not.toContain("RSA cryptosystem");
    expect(top.map((t) => t.title)).not.toContain("Public-key cryptography");
    // The best passage names actual quantum-resistant schemes.
    expect(top[0].text).toMatch(PQ);
  });

  it("finds the NIST standards, including ML-DSA by name", async () => {
    const top = await topSentences("What are the post-quantum signature schemes NIST standardized?", 6);
    expect(top.some((t) => /ML-DSA/.test(t.text))).toBe(true);
    expect(top.filter((t) => PQ.test(t.text)).length).toBeGreaterThanOrEqual(2);
  });

  it("resolves ML-DSA as a name through the title index when the article exists", async () => {
    // Wikipedia has no standalone ML-DSA article (it redirects to Lattice-based cryptography);
    // the full pack carries that redirect. Without it, keyword search still reaches the right text.
    const top = await topSentences("What is ML-DSA?", 3);
    expect(top.some((t) => /ML-DSA/.test(t.text))).toBe(true);
  });
});
