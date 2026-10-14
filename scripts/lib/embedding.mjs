// The app's embedding model on the computer (bge-small-en-v1.5 through
// node-llama-cpp), shared by the knowledge-pack builders.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";

export const EMBEDDING_MODEL = {
  // BOAR_EMBEDDING_GGUF: a shared copy (e.g. /Users/<you>/boar/shared-models/embedding.gguf) instead of one per checkout.
  path: process.env.BOAR_EMBEDDING_GGUF ?? "assets/models/embedding.gguf",
  url: "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf",
  sha256: "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514",
};

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

/**
 * bge-small reads at most 512 tokens. A chunk is ~1,000 characters, but tables
 * and non-Latin scripts can take more tokens than that: cut to 1,200
 * characters, then halve until it fits.
 */
async function embedFitting(ctx, text) {
  for (let len = Math.min(text.length, 1200); ; len = Math.floor(len / 2)) {
    try {
      return (await ctx.getEmbeddingFor(text.slice(0, len))).vector;
    } catch (e) {
      if (!/longer than the usable context/.test(String(e?.message)) || len < 100) throw e;
    }
  }
}

export async function ensureEmbeddingModel() {
  if (!existsSync(EMBEDDING_MODEL.path)) {
    log(`downloading the embedding model to ${EMBEDDING_MODEL.path}`);
    mkdirSync(dirname(EMBEDDING_MODEL.path), { recursive: true });
    const res = await fetch(EMBEDDING_MODEL.url);
    if (!res.ok) throw new Error(`embedding model download failed: HTTP ${res.status}`);
    writeFileSync(EMBEDDING_MODEL.path, Buffer.from(await res.arrayBuffer()));
  }
  const sha = await sha256File(EMBEDDING_MODEL.path);
  if (sha !== EMBEDDING_MODEL.sha256) {
    throw new Error(`${EMBEDDING_MODEL.path} doesn't match the app's embedding model (sha256 ${sha}); packs must use the same model`);
  }
}

export function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", fail);
  });
}

export async function embedChunks(chunks, cacheFile, threads) {
  // Cache: raw float32 vectors appended in chunk order.
  const dims = 384;
  const have = existsSync(cacheFile) ? Math.floor(statSync(cacheFile).size / (dims * 4)) : 0;
  // A run killed mid-write can leave part of a vector at the end: cut it, so appended vectors stay aligned.
  if (existsSync(cacheFile) && statSync(cacheFile).size !== have * dims * 4) truncateSync(cacheFile, have * dims * 4);
  log(`embeddings: ${have} cached, ${chunks.length - have} to compute`);
  if (have < chunks.length) {
    const { getLlama } = await import("node-llama-cpp");
    // BOAR_EMBED_GPU=metal: 1.9x faster on an M4, cosine >= 0.9998 against CPU vectors (measured 2026-09-26, 200 leads).
    const llama = await getLlama({ gpu: process.env.BOAR_EMBED_GPU || false });
    const model = await llama.loadModel({ modelPath: EMBEDDING_MODEL.path });
    const contexts = await Promise.all(
      Array.from({ length: threads }, () => model.createEmbeddingContext({ contextSize: 512, threads: 2 }))
    );
    const start = Date.now();
    for (let i = have; i < chunks.length; i += threads * 16) {
      const group = chunks.slice(i, i + threads * 16);
      const vectors = new Array(group.length);
      await Promise.all(
        contexts.map(async (ctx, w) => {
          for (let j = w; j < group.length; j += threads) {
            vectors[j] = await embedFitting(ctx, `${group[j].title}\n${group[j].body}`);
          }
        })
      );
      const buf = Buffer.alloc(group.length * dims * 4);
      vectors.forEach((v, j) => {
        if (v.length !== dims) throw new Error(`expected ${dims} dims, got ${v.length}`);
        Float32Array.from(v).forEach((x, k) => buf.writeFloatLE(x, (j * dims + k) * 4));
      });
      appendFileSync(cacheFile, buf);
      const doneNow = i + group.length;
      if (Math.floor(doneNow / 2000) > Math.floor(i / 2000)) {
        const rate = (doneNow - have) / ((Date.now() - start) / 1000);
        log(`embeddings: ${doneNow}/${chunks.length} (${rate.toFixed(0)}/s, ~${Math.round((chunks.length - doneNow) / rate / 60)} min left)`);
      }
    }
    await Promise.all(contexts.map((c) => c.dispose()));
    await model.dispose();
  }
  const raw = readFileSync(cacheFile);
  return new Float32Array(raw.buffer, raw.byteOffset, chunks.length * dims);
}

