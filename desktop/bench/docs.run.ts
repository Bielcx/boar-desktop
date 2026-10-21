/// <reference types="node" />
/**
 * Personal-documents bench (npm run bench -- --docs): does a question about the user's own imported document get
 * that document as its source, when a big Wikipedia pack is installed next to it? The plain bench can't see this:
 * its corpus is 300 articles and no personal document.
 *
 * Setup as bench/engine.run.ts (the app's engine on the desktop shims, fresh data folder, models hard-linked), plus
 * the bench/docs/*.txt files imported as one collection each, and boar-wiki-en-00.sqlite from
 * BOAR_TEST_MODELS_DIR/corpus when it's there (one of the 15 English Wikipedia shards, 390k articles).
 *
 * Retrieval: the rank of the first passage of the right document in retrieve()'s top 6, plus the main bench's
 * retrieval set (questions the bundled corpus answers) to catch a regression. Answers (unless BOAR_BENCH_MODE=quick):
 * every document question through answer(), checked with a regex for the fact.
 *
 * Scoped (npm run bench -- --docs --scoped): every question in a conversation limited to its document's collection
 * ("Ask this document"), plus NEGATIVES: questions the scoped document doesn't answer, where the answer should say so.
 */
import { it, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loopback } from "../src/testing/loopback";
import { register as llamaHandlers } from "../src/main/handlers/llama.rn";
import { register as sqlite } from "../src/main/handlers/expo-sqlite";
import { register as fsLegacy } from "../src/main/handlers/expo-file-system-legacy";
import { register as fsNew } from "../src/main/handlers/expo-file-system";
import { register as ramMonitor } from "../src/main/handlers/ram-monitor";
import { register as fileHash } from "../src/main/handlers/file-hash";

vi.mock("expo-sqlite", () => import("../src/shims/expo-sqlite"));
vi.mock("expo-file-system", () => import("../src/shims/expo-file-system"));
vi.mock("expo-file-system/legacy", () => import("../src/shims/expo-file-system-legacy"));
vi.mock("file-hash", () => import("../src/shims/file-hash"));
vi.mock("ram-monitor", () => import("../src/shims/ram-monitor"));
vi.mock("offline-location", () => import("../src/shims/offline-location"));
vi.mock("download-wake-lock", () => import("../src/shims/download-wake-lock"));
vi.mock("device-key", () => import("../src/shims/device-key"));
vi.mock("voice-input", () => import("../src/shims/voice-input"));
vi.mock("expo-sharing", () => import("../src/shims/expo-sharing"));
vi.mock("expo-document-picker", () => import("../src/shims/expo-document-picker"));
vi.mock("expo-pdf-text-extract", () => import("../src/shims/expo-pdf-text-extract"));
vi.mock("bundled-assets", () => ({ excludeFromBackup: async () => {} }));
vi.mock("llama.rn", () => import("../src/shims/llama.rn"));
vi.mock("react-native", () => ({ Platform: { OS: "web", select: (o: any) => o.web ?? o.default } }));

const env = process.env;
const MODELS_DIR = env.BOAR_TEST_MODELS_DIR ?? "";
const OUT = env.BOAR_BENCH_OUT ?? "";
const WIKI_SHARD = "boar-wiki-en-00.sqlite";
const RETRIEVE_K = 6;

/**
 * --docset <name>: bench/docsets/<name>/ instead of bench/docs, with its questions in questions.json
 * ([{ id, doc, query, fact }], fact a case-insensitive regex; doc = the file name without its extension).
 */
const DOCSET = env.BOAR_BENCH_DOCSET ? path.join(__dirname, "docsets", env.BOAR_BENCH_DOCSET) : "";
const DOCS_DIR = DOCSET || path.join(__dirname, "docs");

/** Questions on bench/docs/*. The topics overlap Wikipedia on purpose (water, property tax, tetanus, generators). */
const BUILTIN_QUESTIONS: Array<{ id: string; doc: string; query: string; fact: RegExp }> = [
  { id: "plan-1", doc: "household-emergency-plan", query: "How much water do we store per person?", fact: /12\s*(l|liters|litres)/i },
  { id: "plan-2", doc: "household-emergency-plan", query: "How many drops of bleach per liter of water?", fact: /\b2\b|two/i },
  { id: "plan-3", doc: "household-emergency-plan", query: "Where is our meeting point if the neighborhood is evacuated?", fact: /parish hall|s[ãa]o jos[ée]/i },
  { id: "plan-pt", doc: "household-emergency-plan", query: "Quantos litros de água guardamos por pessoa?", fact: /12/ },
  { id: "lease-1", doc: "contrato-aluguel", query: "Quem paga o IPTU segundo o contrato?", fact: /locat[áa]rio|inquilino/i },
  { id: "lease-2", doc: "contrato-aluguel", query: "Qual a multa se eu sair do apartamento antes do prazo?", fact: /tr[êe]s alugu|3 alugu/i },
  { id: "lease-3", doc: "contrato-aluguel", query: "Quando o aluguel é reajustado?", fact: /fevereiro|ipca|12 meses/i },
  { id: "vax-1", doc: "clinic-vaccine-record", query: "When is Maria's next tetanus booster due?", fact: /2034/ },
  { id: "vax-2", doc: "clinic-vaccine-record", query: "Is Maria allergic to any antibiotic?", fact: /penicillin/i },
  { id: "gen-1", doc: "manual-gerador", query: "De quanto em quanto tempo devo trocar o óleo do gerador?", fact: /100 horas|6 meses|seis meses/i },
  { id: "gen-2", doc: "manual-gerador", query: "Qual óleo usar no gerador?", fact: /10w-?30/i },
  { id: "gen-3", doc: "manual-gerador", query: "Posso ligar o gerador dentro da garagem?", fact: /n[ãa]o|nunca/i },
];

const QUESTIONS: Array<{ id: string; doc: string; query: string; fact: RegExp }> = DOCSET
  ? JSON.parse(fs.readFileSync(path.join(DOCSET, "questions.json"), "utf8")).map((q: any) => ({ ...q, fact: new RegExp(q.fact, "iu") }))
  : BUILTIN_QUESTIONS;

/** Scoped mode only: asked of a document that doesn't answer them. Honest = declines or says the document doesn't say. */
const NEGATIVES: Array<{ id: string; doc: string; query: string; wrong: RegExp }> = [
  { id: "neg-burn", doc: "contrato-aluguel", query: "Como tratar uma queimadura?", wrong: /água (fria|corrente)|resfri/i },
  { id: "neg-lease", doc: "manual-gerador", query: "Qual a multa se eu sair do apartamento antes do prazo?", wrong: /tr[êe]s alugu|3 alugu/i },
  { id: "neg-vax", doc: "household-emergency-plan", query: "When is Maria's next tetanus booster due?", wrong: /2034/ },
  { id: "neg-paris", doc: "clinic-vaccine-record", query: "What is the capital of France?", wrong: /paris/i },
];
const HONEST = /n[ãa]o (tenho|encontrei|menciona|h[áa]|cont[ée]m|diz|informa|fala|traz|aborda|especifica)|n[ãa]o est[áa]|doesn'?t (say|mention|contain|include|specify|cover)|does not (say|mention|contain|include|specify|cover)|no (information|mention)|not (mentioned|specified|covered|found|in the)|didn'?t find/i;
const SCOPED = env.BOAR_BENCH_SCOPED === "1";

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

it("personal documents", async () => {
  if (!MODELS_DIR) throw new Error("BOAR_TEST_MODELS_DIR is not set (folder with the app's .gguf files)");
  const { MODEL_CATALOG } = await import("../../src/models/manifest");
  const modelArg = env.BOAR_BENCH_MODEL || "qwen2.5-1.5b-instruct-q4km";
  const llm = MODEL_CATALOG.find((m) => m.kind === "llm" && (m.id === modelArg || path.basename(m.filename) === modelArg))!;
  const emb = MODEL_CATALOG.find((m) => m.id === "bge-small-en-v1.5-q8")!;

  // Only those over 3 hours old: another run may be going in parallel (another worktree).
  const stale = (d: string) => Date.now() - fs.statSync(path.join(os.tmpdir(), d)).mtimeMs > 3 * 3600_000;
  for (const d of fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("boar-docs-"))) {
    try {
      if (stale(d)) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    } catch {}
  }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "boar-docs-")));
  const dataDir = path.join(root, "data");
  const { native, ctx } = loopback(dataDir);
  for (const register of [sqlite, fsLegacy, fsNew, ramMonitor, fileHash, llamaHandlers]) register(ctx);
  (globalThis as any).window = { boarNative: native };
  const documents = path.join(dataDir, "documents");
  fs.mkdirSync(path.join(documents, "models"), { recursive: true });
  for (const m of [llm, emb]) fs.linkSync(path.join(MODELS_DIR, path.basename(m.filename)), path.join(documents, m.filename));
  const shard = path.join(MODELS_DIR, "corpus", WIKI_SHARD);
  const withWiki = fs.existsSync(shard);
  if (withWiki) {
    fs.mkdirSync(path.join(documents, "corpus"), { recursive: true });
    fs.linkSync(shard, path.join(documents, "corpus", WIKI_SHARD));
  }

  try {
    const settings = await import("../../src/models/settings");
    await settings.setActiveModelId("llm", llm.id);
    const { embeddingEngine } = await import("../../src/rag/embed");
    const { seedKnowledgeBaseIfEmpty } = await import("../../src/rag/seedCorpus");
    const { retrieve } = await import("../../src/rag/retrieve");
    const { importDocuments } = await import("../../src/services/documentImporter");
    const { EVAL_SET, EVAL_SET_VERSION } = await import("../../src/eval/evalSet");
    await embeddingEngine.load(emb.filename);
    await seedKnowledgeBaseIfEmpty();

    // Each document as its own collection, imported the way Settings > Knowledge Base > Import does it.
    const cache = path.join(dataDir, "app-cache");
    const collectionOf: Record<string, string> = {};
    for (const f of fs.readdirSync(DOCS_DIR).filter((f) => f !== "questions.json")) {
      const p = path.join(cache, f);
      fs.copyFileSync(path.join(DOCS_DIR, f), p);
      const doc = f.replace(/\.(txt|md)$/, "");
      const mimeType = f.endsWith(".md") ? "text/markdown" : "text/plain";
      const c = await importDocuments([{ uri: pathToFileURL(p).href, name: f, size: fs.statSync(p).size, mimeType } as any], doc);
      collectionOf[doc] = c.id;
    }

    // The diagnosis: best cosine of each document's passages to the question (bge-small; the gate is 0.7).
    const { getDb } = await import("../../src/rag/db");
    const { cosineSimilarity } = await import("../../src/rag/pure");
    const personal = await (await getDb()).getAllAsync<{ doc_id: string; embedding: Uint8Array }>(
      "SELECT c.doc_id, e.embedding FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.chunk_id WHERE c.collection_id IS NOT NULL"
    );
    const bestSim = async (query: string) => {
      const v = await embeddingEngine.embed(query);
      const best: Record<string, number> = {};
      for (const r of personal) {
        const doc = Object.keys(collectionOf).find((d) => r.doc_id.startsWith(collectionOf[d]))!;
        const s = cosineSimilarity(v, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4));
        best[doc] = round(Math.max(best[doc] ?? -1, s));
      }
      return best;
    };

    // 1. Retrieval: rank of the right document among the sources.
    const docs = [];
    for (const q of QUESTIONS) {
      const t0 = performance.now();
      const hits = await retrieve(q.query, RETRIEVE_K, SCOPED ? { collections: [collectionOf[q.doc]] } : {});
      const rank = hits.findIndex((h) => h.docId.startsWith(collectionOf[q.doc])) + 1;
      const ms = Math.round(performance.now() - t0);
      const sims = await bestSim(q.query);
      docs.push({ id: q.id, query: q.query, rank, ms, sim: sims[q.doc], sims, got: hits.map((h) => h.title) });
    }
    // Regression: the main bench's retrieval set must still find its articles with the documents installed, and
    // a general question shouldn't bring a personal document.
    // Plus Portuguese ones (bench/engine.run.ts's EXTRA_SET): bge-small reads Portuguese poorly, so any Portuguese
    // question sits closer to any Portuguese document than an English one would.
    const positives = [
      ...EVAL_SET.filter((q) => q.expectedKbTitles.length > 0),
      { id: "pt-1", query: "Como funcionam as vacinas?", expectedKbTitles: ["Vaccine"] },
      { id: "pt-2", query: "O que é a fotossíntese?", expectedKbTitles: ["Photosynthesis"] },
      { id: "pt-3", query: "O que é um buraco negro?", expectedKbTitles: ["Black hole"] },
      { id: "pt-5", query: "Por que o Império Romano do Ocidente caiu?", expectedKbTitles: ["Fall of the Western Roman Empire"] },
      { id: "pt-6", query: "Quanto tempo uma pessoa sobrevive sem água?", expectedKbTitles: [] },
      { id: "pt-7", query: "Como tratar uma queimadura?", expectedKbTitles: [] },
    ];
    const general = [];
    for (const q of positives) {
      const hits = await retrieve(q.query, RETRIEVE_K);
      const titles = [...new Set(hits.map((h) => h.title))];
      const personalTitles = hits.filter((h) => h.docId.startsWith("custom-")).map((h) => h.title);
      general.push({ id: q.id, hit: q.expectedKbTitles.every((t) => titles.includes(t)), personal: personalTitles, sims: await bestSim(q.query), got: titles });
    }

    // 2. Answers through answer(), the chat's pipeline.
    let answers: any[] = [];
    let negatives: any[] = [];
    if (env.BOAR_BENCH_MODE !== "quick") {
      const { llamaEngine } = await import("../../src/inference/LlamaEngine");
      await llamaEngine.load(llm.filename, { meta: { modelId: llm.id, label: llm.label } });
      const { runAnswerEvaluation } = await import("../../src/eval/answerEval");
      const asked = [...QUESTIONS, ...(SCOPED ? NEGATIVES : [])];
      const run = await runAnswerEvaluation({
        questions: asked.map((q) => ({ id: q.id, query: q.query, category: "retrieval-grounded", ...(SCOPED ? { collections: [collectionOf[q.doc]] } : {}) })),
        evalSetVersion: EVAL_SET_VERSION,
      });
      answers = run.rows.filter((r) => QUESTIONS.some((q) => q.id === r.queryId)).map((r) => {
        const q = QUESTIONS.find((x) => x.id === r.queryId)!;
        const cited = r.retrievedTitles.some((t: string) => t.startsWith(q.doc));
        return { id: q.id, declined: r.declined, cited, fact: !r.declined && q.fact.test(r.answer), reasonCodes: r.reasonCodes, answer: r.answer };
      });
      negatives = run.rows.filter((r) => NEGATIVES.some((q) => q.id === r.queryId)).map((r) => {
        const q = NEGATIVES.find((x) => x.id === r.queryId)!;
        const honest = r.declined || (HONEST.test(r.answer) && !q.wrong.test(r.answer));
        return { id: q.id, declined: r.declined, honest, reasonCodes: r.reasonCodes, answer: r.answer };
      });
      await llamaEngine.unload();
    }
    await embeddingEngine.unload();

    let commit = "";
    try {
      commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain", { encoding: "utf8" }).trim() ? "+dirty" : "");
    } catch {}
    const result = {
      meta: { label: env.BOAR_BENCH_LABEL || "run", docset: env.BOAR_BENCH_DOCSET || "docs", scoped: SCOPED, date: new Date().toISOString(), commit, model: llm.id, wikiPack: withWiki ? WIKI_SHARD : null },
      docs: {
        questions: docs.length,
        hitAt1: round(avg(docs.map((d) => (d.rank === 1 ? 1 : 0)))),
        hitAt4: round(avg(docs.map((d) => (d.rank >= 1 && d.rank <= 4 ? 1 : 0)))),
        hitAt6: round(avg(docs.map((d) => (d.rank >= 1 ? 1 : 0)))),
        generalHits: `${general.filter((g) => g.hit).length}/${general.length}`,
        generalWithPersonal: general.filter((g) => g.personal.length).length,
        answered: answers.length ? `${answers.filter((a) => !a.declined).length}/${answers.length}` : null,
        factsPassed: answers.length ? `${answers.filter((a) => a.fact).length}/${answers.length}` : null,
        cited: answers.length ? `${answers.filter((a) => a.cited).length}/${answers.length}` : null,
        negativesHonest: negatives.length ? `${negatives.filter((a) => a.honest).length}/${negatives.length}` : null,
      },
      perQuestion: docs,
      general,
      answers,
      negatives,
    };
    console.log(JSON.stringify(result.docs, null, 2));
    for (const d of docs) console.log(`${d.rank ? `#${d.rank}` : "--"}  ${d.id}  ${d.got.slice(0, 4).join(" | ")}`);
    for (const a of answers) console.log(`${a.fact ? "OK " : a.declined ? "DEC" : "BAD"} ${a.id}  ${a.answer.replace(/\s+/g, " ").slice(0, 110)}`);
    for (const a of negatives) console.log(`${a.honest ? "OK " : "BAD"} ${a.id}  ${a.answer.replace(/\s+/g, " ").slice(0, 110)}`);
    if (OUT) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    }
  } finally {
    try {
      await (await (await import("../../src/rag/db")).getDb()).closeAsync();
    } catch {}
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {}
  }
});
