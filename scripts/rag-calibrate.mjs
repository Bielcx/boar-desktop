// Prints the real semantic similarity of the top knowledge-pack candidates for a set of questions,
// to calibrate the relevance floor in src/rag/pure.ts (ANSWER_MIN_SIMILARITY). It uses the app's
// own search code (buildLexicalQuery, cosineSimilarityInt8) and embedding model, over a pack
// built with scripts/build-knowledge-pack.mjs.
//
//   node scripts/rag-calibrate.mjs [build/knowledge-pack/wiki-vital5.sqlite]
//
// It imports src/rag/pure.ts directly. Node 22.18+ and 23.6+ do that as is; on older Node 22
// releases, add the flag: node --experimental-strip-types scripts/rag-calibrate.mjs
import { DatabaseSync } from "node:sqlite";
import { getLlama } from "node-llama-cpp";
import { buildLexicalQuery, cosineSimilarityInt8, gateByRelevance } from "../src/rag/pure.ts";

const packPath = process.argv[2] ?? "build/knowledge-pack/wiki-vital5.sqlite";

// [question, title that should come first, or "" when nothing should be retrieved]
const CASES = [
  ["What is the capital of Australia?", "Canberra"],
  ["Who proposed the theory of evolution by natural selection?", "Natural selection"],
  ["How do vaccines work?", "Vaccine"],
  ["Explain photosynthesis in simple terms.", "Photosynthesis"],
  ["Why did the Western Roman Empire fall?", "Fall of the Western Roman Empire"],
  ["What is a black hole and how does one form?", "Black hole"],
  ["Who was Napoleon Bonaparte?", "Napoleon"],
  ["How do antibiotics work, and why does antibiotic resistance develop?", "Antibiotic"],
  ["Why plant corn, beans and squash together?", "Companion planting"],
  ["My friend is shivering and slurring words. Is it hypothermia?", "Hypothermia"],
  ["whats your name?", ""],
  ["who are you?", ""],
  ["what can you do?", ""],
  ["tell me a joke", ""],
  ["what time is it?", ""],
  ["can you help me?", ""],
];

const db = new DatabaseSync(packPath, { readOnly: true });
const llama = await getLlama();
const model = await llama.loadModel({ modelPath: "assets/models/embedding.gguf" });
const ctx = await model.createEmbeddingContext();

for (const [q, expected] of CASES) {
  const vec = new Float32Array((await ctx.getEmbeddingFor(q)).vector);
  const lq = buildLexicalQuery(q);
  const rows = lq
    ? (db.prepare(
        `SELECT c.title, c.vec FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 400`
      ).all(lq.match) )
    : [];
  const scored = rows
    .map((r) => ({ title: r.title, sim: cosineSimilarityInt8(vec, r.vec) }))
    .sort((a, b) => b.sim - a.sim)
    .filter((r, i, all) => all.findIndex((x) => x.title === r.title) === i)
    .slice(0, 4);
  const top = scored.map((r) => `${r.title} ${r.sim.toFixed(2)}`).join(" | ");
  const kept = gateByRelevance(scored.map((r) => ({ ...r, similarity: r.sim }))).map((r) => r.title);
  console.log(`${expected ? "WANT " + expected.padEnd(32) : "WANT nothing".padEnd(37)} terms=[${lq?.terms.join(",") ?? ""}]\n    ${q}\n    ${top || "(no keyword candidates)"}\n    gate keeps ${kept.length}: ${kept.join(", ") || "-"}`);
}
