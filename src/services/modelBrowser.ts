import { CatalogModel } from "../models/manifest";
import { networkAllowed } from "../config/variant";

/**
 * Search Hugging Face for GGUF models beyond the fixed, hand-picked
 * MODEL_CATALOG. This is the app's second and ONLY OTHER source of network
 * access besides the model-setup downloads — used exclusively when the user
 * explicitly searches/downloads here, never automatically and never during
 * chat/inference.
 *
 * Unlike MODEL_CATALOG entries, these aren't vetted by anyone who's run
 * them — no one has confirmed they actually fit typical phone RAM, run
 * cleanly in llama.rn, or aren't mislabeled. The download URL is pinned to
 * the repo commit seen when the files were listed, and when Hugging Face's
 * LFS metadata gives a sha256 (siblings[].lfs.oid) ModelManager verifies it
 * after download like any catalog entry; without one, only the size is
 * checked. Disabled entirely in the offline build (no INTERNET permission).
 */

const HF_API = "https://huggingface.co/api";

export interface HFModelSummary {
  id: string; // e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF"
  downloads?: number;
  likes?: number;
  /** Parameter count from the GGUF header. */
  params?: number;
}

export interface HFGgufFile {
  filename: string;
  sizeBytes: number;
  sha256: string | null;
  /** Repo commit the listing came from, so the download can't drift from what was shown. */
  revision: string | null;
}

function assertNetwork(): void {
  if (!networkAllowed()) throw new Error("Model search is not available in the offline build of BOAR.");
}

/** A file over this can't run in BOAR's 12 GB RAM budget (and would take the whole disk). */
export const MAX_FILE_BYTES = 12 * 1024 ** 3;

/** Parameter buckets, as on huggingface.co/models; capped at 20B, past which no Q4 file fits under MAX_FILE_BYTES. */
export const HF_SIZES = {
  any: ["0", "20B"],
  under1b: ["0", "1B"],
  "1to3b": ["1B", "3B"],
  "3to6b": ["3B", "6B"],
  "6to9b": ["6B", "9B"],
  "9to20b": ["9B", "20B"],
} as const;
export type HFSize = keyof typeof HF_SIZES;

export const HF_SORTS = { trending: "trendingScore", downloads: "downloads", likes: "likes", newest: "lastModified" } as const;
export type HFSort = keyof typeof HF_SORTS;

/**
 * Text-generation architectures llama.cpp loads and BOAR can chat with (the native app's HfQuery.CHAT_ARCHITECTURES):
 * its LLM_ARCH_NAMES without encoders and embedders, speech, OCR, speculative-decoding drafts, vision-only and
 * diffusion models. Update with node-llama-cpp's llama.cpp.
 */
export const CHAT_ARCHITECTURES = new Set([
  "llama", "llama4", "deci", "falcon", "grok", "gpt2", "gptj", "gptneox", "mpt", "baichuan", "starcoder",
  "refact", "bloom", "stablelm", "qwen", "qwen2", "qwen2moe", "qwen2vl", "qwen3", "qwen3moe", "qwen3next",
  "qwen3vl", "qwen3vlmoe", "qwen35", "qwen35moe", "qwen4exp", "phi2", "phi3", "phimoe", "plamo", "plamo2",
  "plamo3", "codeshell", "orion", "internlm2", "minicpm", "minicpm3", "gemma", "gemma2", "gemma3", "gemma3n",
  "gemma4", "starcoder2", "mamba", "mamba2", "maple", "jamba", "falcon-h1", "xverse", "command-r", "cohere2",
  "cohere2moe", "dbrx", "olmo", "olmo2", "olmoe", "muse-glimmer", "openelm", "arctic", "deepseek", "deepseek2",
  "deepseek32", "deepseek4", "chatglm", "glm4", "glm4moe", "glm-dsa", "bitnet", "jais", "jais2", "nemotron",
  "nemotron_h", "nemotron_h_moe", "exaone", "exaone4", "exaone-moe", "rwkv6", "rwkv6qwen2", "rwkv7", "arwkv7",
  "granite", "granitemoe", "granitehybrid", "graniteswitch", "granite_swa", "plm", "bailingmoe", "bailingmoe2",
  "bailingmoe3", "dots1", "dots3note", "arcee", "afmoe", "laguna", "ernie4_5", "ernie4_5-moe", "hunyuan-moe",
  "hunyuan-dense", "hunyuan_vl", "hy_v3", "hy_v4", "smollm3", "gpt-oss", "lfm2", "lfm2moe",
  "smallthinker", "seed_oss", "grovemoe", "apertus", "minimax-01", "hrm_text",
  "minimax-m2", "minimax-m3", "pangu-embedded", "mistral3", "mistral4", "mimo2", "step35", "spark2_5",
  "maincoder", "kimi-linear", "kimi-k3", "talkie", "mellum", "nanbeige",
]);

/** Text-generation GGUF repos in the size bucket, with their GGUF header facts; no query browses them all. */
export function searchUrl(query: string, size: HFSize, sort: HFSort, limit = 30): string {
  const q = query.trim() ? `search=${encodeURIComponent(query.trim())}&` : "";
  const [min, max] = HF_SIZES[size];
  return (
    `${HF_API}/models?${q}filter=gguf&pipeline_tag=text-generation&num_parameters=min:${min},max:${max}` +
    `&sort=${HF_SORTS[sort]}&direction=-1&limit=${limit}&expand[]=gguf&expand[]=downloads&expand[]=likes&expand[]=tags`
  );
}

const UNCENSORED_WORDS = new Set([
  "uncensored", "abliterated", "abliteration", "nsfw", "erotic", "erp", "lewd", "porn", "hentai", "unaligned", "adult",
]);

/**
 * An uncensored or adult model, hidden from Discover unless the build allows them (EXPO_PUBLIC_ALLOW_UNCENSORED_MODELS,
 * the native app's ALLOW_UNCENSORED_MODELS): Hugging Face's own adult tag, or a telling word in the repo name or tags.
 * A name check, so it misses quiet ones.
 */
export function uncensored(repoId: string, tags: string[] = []): boolean {
  if (tags.includes("not-for-all-audiences")) return true;
  return [repoId, ...tags].some((s) => s.toLowerCase().split(/[^a-z0-9]+/).some((w) => UNCENSORED_WORDS.has(w)));
}

const allowUncensored = () => process.env.EXPO_PUBLIC_ALLOW_UNCENSORED_MODELS === "true";

const SPLIT_PART = /-\d{5}-of-\d{5}\.gguf$/i;

/** One whole model file: a .gguf, not one part of a split model, not a vision projector, and not over MAX_FILE_BYTES. */
export function addableFile(name: string, sizeBytes: number): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".gguf") && !SPLIT_PART.test(lower) && !lower.includes("mmproj") && sizeBytes > 0 && sizeBytes <= MAX_FILE_BYTES;
}

/** "2.7B", "500M". */
export function formatParams(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B` : `${Math.round(n / 1e6)}M`;
}

export async function searchModels(query: string, size: HFSize = "any", sort: HFSort = "trending"): Promise<HFModelSummary[]> {
  assertNetwork();
  const res = await fetch(searchUrl(query, size, sort));
  if (!res.ok) throw new Error(`Hugging Face search failed (${res.status})`);
  const data = await res.json();
  return (data as any[])
    .filter((m) => typeof m.id === "string" && CHAT_ARCHITECTURES.has(m.gguf?.architecture))
    .filter((m) => allowUncensored() || !uncensored(m.id, Array.isArray(m.tags) ? m.tags : []))
    .map((m) => ({ id: m.id, downloads: m.downloads, likes: m.likes, params: typeof m.gguf?.total === "number" ? m.gguf.total : undefined }));
}

export async function listGgufFiles(repoId: string): Promise<HFGgufFile[]> {
  assertNetwork();
  const url = `${HF_API}/models/${repoId}?blobs=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to list files for ${repoId} (${res.status})`);
  const data = await res.json();
  const siblings: any[] = data.siblings ?? [];
  const revision = typeof data.sha === "string" && /^[0-9a-f]{40}$/.test(data.sha) ? data.sha : null;
  return siblings
    .filter((s) => typeof s.rfilename === "string" && addableFile(s.rfilename, s.size ?? 0))
    .map((s) => ({
      filename: s.rfilename,
      sizeBytes: s.size ?? 0,
      sha256: s.lfs?.oid ?? null,
      revision,
    }))
    .sort((a, b) => a.sizeBytes - b.sizeBytes);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function toCatalogModel(repoId: string, file: HFGgufFile): CatalogModel {
  const id = `hf-${slug(repoId)}-${slug(file.filename)}`.slice(0, 120);
  return {
    id,
    kind: "llm",
    label: file.filename.replace(/\.gguf$/i, ""),
    filename: `models/${id}.gguf`,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256 ?? "",
    sourceUrl: `https://huggingface.co/${repoId}/resolve/${file.revision ?? "main"}/${file.filename}`,
    license: "Unknown — check the model's Hugging Face page",
    description: `${repoId} — added via model search, not vetted by BOAR`,
    required: false,
  };
}
