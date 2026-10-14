/**
 * Model + corpus catalog. Every asset the app can use is declared here with
 * an expected sha256 so ModelManager can verify integrity and the total
 * footprint can be audited against the 50GB storage cap.
 *
 * `required: true` entries are the default LLM + embedding model. They are
 * NOT bundled inside the app build (that keeps the installable app small
 * and fast to build/ship — see modules/bundled-assets + plugins/withBundledModels.js
 * for an alternate fully-bundled build path, still available but not used
 * by default). Instead, on first launch the app shows a mandatory setup
 * screen (src/ui/ModelSetupScreen.tsx in "required" mode) that downloads
 * them — the ONLY time the app needs network access. Once downloaded, the
 * app works fully offline from then on, matching the bounty's "work
 * completely offline once installed" requirement (installed = app +
 * one-time model setup complete).
 *
 * `required: false` entries are optional extras a user can fetch later from
 * the same Models/Settings screen in its normal (non-blocking) mode — either
 * an alternate LLM, or a corpus pack (see TIERS below).
 */

import type { ModelCapabilities } from "../routing/types";

export type AssetKind = "llm" | "embedding" | "corpus";
export type SetupTier = "minimum" | "standard" | "full" | "encyclopedia";

export interface CatalogModel {
  id: string;
  kind: AssetKind;
  /** Technical name (model, size, quantization): for detail views, logs and the install list. */
  label: string;
  /**
   * Short name for the UI, without quantization or release tags ("Qwen3 4B",
   * not "Qwen3-4B-Instruct-2507 (Q4_K_M)"). Set for every model; read it
   * with displayNameOf(), which falls back to `label` for other assets.
   */
  displayName?: string;
  /** Relative path under FileSystem.documentDirectory once installed */
  filename: string;
  sizeBytes: number;
  sha256: string;
  sourceUrl: string;
  license: string;
  description: string;
  /**
   * Must be installed before the app can be used (the embedding model). The
   * answer model is chosen instead: any one entry with an `answerTier`.
   */
  required: boolean;
  /**
   * LLMs that can be the app's answer model at setup. "default" is what the
   * setup installs unless the phone is short on RAM or the user picks
   * "compact". Setup is complete with the required assets plus ONE of these.
   */
  answerTier?: "default" | "compact";
  /**
   * No longer suggested: the catalog lists it only on a phone that already has it, where it keeps working
   * (Phi-3.5-mini: ~4 tok/s on the X6 and it invented citations in our device benchmark).
   */
  hidden?: boolean;
  /**
   * Ships inside the app build itself (see plugins/withBundledModels.js).
   * Not used by default — see module doc comment — but kept available.
   */
  bundled?: boolean;
  /**
   * Which adaptive-routing roles this model is hand-curated as suitable
   * for (see src/routing/types.ts's ModelCapabilities doc comment — a
   * maintainer's judgment call based on parameter count/class, not a
   * benchmark result). Absent/undefined for entries added before this field
   * existed and for anything from discoveredModels.ts (Hugging Face search
   * results aren't vetted the same way as this curated catalog) — routing
   * resolution must treat "no capabilities" as "not yet assessed", never
   * assume a role.
   */
  capabilities?: ModelCapabilities;
  /**
   * For kind "corpus": "json" (default) is a list of documents indexed on the
   * phone after download; "sqlite-pack" is a knowledge pack built on a computer
   * (scripts/build-knowledge-pack.mjs) with its own search index and
   * embeddings, opened directly (src/rag/packs.ts).
   */
  format?: "json" | "sqlite-pack" | "poi-pack";
  /**
   * Ids of assets this one is useless without, installed with it: a places
   * pack needs the world gazetteer to answer "restaurants in <city>" (PL-1).
   * Resolved in the asset registry (src/models/assetRegistry.ts).
   */
  requires?: string[];
}

// Decimal, as the bounty and the phone count it (50 GB = 50e9 bytes; Prism N-14).
export const STORAGE_BUDGET_BYTES = 50 * 1000 ** 3;
export const RAM_BUDGET_BYTES = 12 * 1024 * 1024 * 1024; // 12GB

/**
 * See docs/MODELS.md for the rationale behind each pick (licensing,
 * size/RAM tradeoffs). Every sourceUrl is pinned to an immutable revision
 * (a Hugging Face commit, a repo commit for raw.githubusercontent.com, or a
 * release asset) so the bytes behind a URL can't change; `sha256` is checked
 * on the phone after every download and import (ModelManager). Run
 * `npm run manifest:verify` to re-check sizes and hashes against the hosts.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: "phi-3.5-mini-instruct-q4km",
    kind: "llm",
    label: "Phi-3.5-mini-instruct (Q4_K_M)",
    displayName: "Phi 3.5 Mini",
    filename: "models/primary-llm.gguf",
    sizeBytes: 2393232672,
    sha256: "e4165e3a71af97f1b4820da61079826d8752a2088e313af0c7d346796c38eff5",
    sourceUrl:
      "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/6d70da17e749a471ccb62ade694486011a75cda3/Phi-3.5-mini-instruct-Q4_K_M.gguf",
    license: "MIT",
    description: "3.8B dense. Most complete comparisons and syntheses in our device benchmark, but slow (~4 tok/s). ~2.4GB.",
    required: false,
    hidden: true,
    capabilities: { roles: ["general", "reasoning"] },
  },
  {
    id: "bge-small-en-v1.5-q8",
    kind: "embedding",
    label: "bge-small-en-v1.5 (Q8_0)",
    displayName: "BGE Small",
    filename: "models/embedding.gguf",
    sizeBytes: 36806944,
    sha256: "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514",
    sourceUrl:
      "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/d32f8c040ea3b516330eeb75b72bcc2d3a780ab7/bge-small-en-v1.5-q8_0.gguf",
    license: "MIT",
    description: "33M, sentence embeddings for the local vector index. Default.",
    required: true,
    capabilities: { roles: ["embedding"] },
  },
  {
    id: "qwen3-4b-instruct-2507-q4km",
    kind: "llm",
    label: "Qwen3-4B-Instruct-2507 (Q4_K_M)",
    displayName: "Qwen3 4B",
    filename: "models/qwen3-4b-instruct-2507-q4km.gguf",
    // The exact file the frontier evaluation measured (unsloth build; sha256
    // checked against a local copy on 2026-09-26).
    sizeBytes: 2497281120,
    sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
    sourceUrl:
      "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    license: "Apache-2.0",
    description: "4B dense, non-thinking instruct model. The default answer model: much better explanations and comparisons than the 1.5B. ~2.5GB.",
    required: false,
    answerTier: "default",
    capabilities: { roles: ["general", "fast"], usesChatTemplate: true },
  },
  {
    id: "qwen2.5-1.5b-instruct-q4km",
    kind: "llm",
    label: "Qwen2.5-1.5B-Instruct (Q4_K_M)",
    displayName: "Qwen2.5 1.5B",
    filename: "models/qwen2.5-1.5b-instruct-q4km.gguf",
    sizeBytes: 986048768,
    sha256: "1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370",
    sourceUrl:
      "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/9eadc66189c7641e1ddd226b8267a9119b2ce2d4/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
    license: "Apache-2.0",
    description: "1.5B dense, fast (~11-18 tok/s) and light. ~1.0GB. Compact answer model for phones with little RAM.",
    required: false,
    answerTier: "compact",
    // Real-device Phase 9 test ("whats up?" -> a long, rambling,
    // free-associated multi-question response) traced to the app's
    // hand-built "Question: ...\n\nAnswer:" prompt shape being outside
    // Qwen2.5-Instruct's own fine-tuned ChatML template — see
    // routing/types.ts's ModelCapabilities.usesChatTemplate doc comment.
    capabilities: { roles: ["fast"], usesChatTemplate: true },
  },
  {
    id: "qwen2.5-7b-instruct-q4km",
    kind: "llm",
    label: "Qwen2.5-7B-Instruct (Q4_K_M)",
    displayName: "Qwen2.5 7B",
    filename: "models/qwen2.5-7b-instruct-q4km.gguf",
    sizeBytes: 4683074240,
    sha256: "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423",
    sourceUrl:
      "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/8911e8a47f92bac19d6f5c64a2e2095bd2f7d031/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    license: "Apache-2.0",
    description: "7B dense, stronger reasoning, more RAM/storage/time. ~4.7GB.",
    required: false,
    capabilities: { roles: ["reasoning", "verifier"] },
  },
  // Tested on a real phone (docs/DEVICE_EVALUATION.md) and offered as suggestions so users
  // don't have to search for them. No routing roles yet: they're used when picked with
  // "Select & Use" (adaptive routing off). Filenames match what the Hugging Face browser
  // saves for the same file, so a copy downloaded through search counts as installed.
  {
    id: "lfm2.5-8b-a1b-q4km",
    kind: "llm",
    label: "LFM2.5-8B-A1B (Q4_K_M)",
    displayName: "LFM2.5 8B",
    filename: "models/hf-liquidai-lfm2-5-8b-a1b-gguf-lfm2-5-8b-a1b-q4-k-m-gguf.gguf",
    sizeBytes: 5155564768,
    sha256: "4923ec14f06b968b74d663e5949867d2d9c3bf13a20b8be1a9f9af39989b2bb0",
    sourceUrl: "https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF/resolve/49c14831707011e64d70b2ebd8462ba08d608434/LFM2.5-8B-A1B-Q4_K_M.gguf",
    license: "LFM Open License v1.0",
    description:
      "Mixture of experts: 8B total, ~1.5B active per token. Fastest in our benchmark (~15 tok/s) and the best reasoning, but it thinks before answering, so give it a bigger answer budget. ~5.2GB.",
    required: false,
  },
  {
    id: "gemma-4-e4b-it-q4_0",
    kind: "llm",
    label: "Gemma 4 E4B (QAT Q4_0)",
    displayName: "Gemma 4 E4B",
    filename: "models/hf-google-gemma-4-e4b-it-qat-q4-0-gguf-gemma-4-e4b-q4-0-it-gguf.gguf",
    sizeBytes: 5154941280,
    sha256: "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee",
    sourceUrl: "https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/gemma-4-E4B_q4_0-it.gguf",
    license: "Apache-2.0",
    description: "Google's on-device model, ~4B effective parameters, quantization-aware Q4_0. ~5.2GB.",
    required: false,
  },
  {
    id: "corpus-standard",
    kind: "corpus",
    label: "Standard knowledge base (+1,000 topics)",
    filename: "corpus/corpus-standard.json",
    sizeBytes: 614084,
    sha256: "2aeff76db48098851e1304fb37dc8013d9facf9214395897e7e05f276f85d2ff",
    sourceUrl:
      "https://raw.githubusercontent.com/rferrari/boar-app/9e46dc4d8f9a95bc7716194b94117f769504c0e0/assets/corpus/corpus-standard.json",
    license: "CC BY-SA 4.0 (Wikipedia)",
    description: "1,000 additional Wikipedia-derived topics for local RAG. ~600KB.",
    required: false,
  },
  {
    id: "corpus-full",
    kind: "corpus",
    label: "Full knowledge base (+4,000 topics)",
    filename: "corpus/corpus-full.json",
    sizeBytes: 2530725,
    sha256: "6d602003bb9da59200e3e55b75b9e15bb073a4b9b1357da2c2d47b2803c570be",
    sourceUrl:
      "https://raw.githubusercontent.com/rferrari/boar-app/9e46dc4d8f9a95bc7716194b94117f769504c0e0/assets/corpus/corpus-full.json",
    license: "CC BY-SA 4.0 (Wikipedia)",
    description: "4,000 more Wikipedia-derived topics for local RAG. ~2.4MB.",
    required: false,
  },
  {
    // Built by scripts/build-knowledge-pack.mjs (docs/KNOWLEDGE_PACKS.md) and
    // published as a GitHub Release asset; too large for the repository.
    id: "wiki-vital5",
    kind: "corpus",
    format: "sqlite-pack",
    label: "Wikipedia Vital Articles (+50,000 articles)",
    filename: "corpus/wiki-vital5.sqlite",
    sizeBytes: 163647488,
    sha256: "d3b87d562baba3489f6878bf99783f50d504db94c347029771e53f6d1aecc666",
    sourceUrl: "https://github.com/rferrari/boar-app/releases/download/knowledge-pack-v1/wiki-vital5.sqlite",
    license: "CC BY-SA 4.0 (Wikipedia)",
    description: "Introductions of Wikipedia's ~50,000 Vital Articles (level 5), searchable offline. ~164MB.",
    required: false,
  },
  // Add more tested candidates / corpus packs here later (each needs a
  // unique `id` and `filename`). They ship with `required: false` and
  // appear in the Settings screen as optional downloads.
];

/** LLMs that can be the answer model, default first. */
export const ANSWER_MODELS = MODEL_CATALOG.filter((m) => m.kind === "llm" && m.answerTier).sort(
  (a, b) => (a.answerTier === "default" ? -1 : 1) - (b.answerTier === "default" ? -1 : 1)
);
export const DEFAULT_ANSWER_MODEL = ANSWER_MODELS.find((m) => m.answerTier === "default")!;
export const COMPACT_ANSWER_MODEL = ANSWER_MODELS.find((m) => m.answerTier === "compact")!;

/**
 * The default setup set: every required asset (the embedding model) plus the
 * default answer model. Setup is COMPLETE with the required assets plus any
 * one answer model (ModelManager.requiredModelsPresent), so a phone that
 * installed the compact one instead is set up too.
 */
export const REQUIRED_MODELS = [...MODEL_CATALOG.filter((m) => m.required), DEFAULT_ANSWER_MODEL];
export const CORPUS_CATALOG = MODEL_CATALOG.filter((m) => m.kind === "corpus");

export interface TierDefinition {
  id: SetupTier;
  label: string;
  description: string;
  /** ids of CORPUS_CATALOG entries this tier downloads, in addition to the required models. */
  corpusPackIds: string[];
}

export const TIERS: TierDefinition[] = [
  {
    id: "minimum",
    label: "Minimum",
    description: "Models only. Uses the built-in 300-topic knowledge base — no extra download.",
    corpusPackIds: [],
  },
  {
    id: "standard",
    label: "Standard",
    description: "+ 1,000 more Wikipedia-derived topics (~600KB extra download).",
    corpusPackIds: ["corpus-standard"],
  },
  {
    id: "full",
    label: "Full",
    description: "+ 5,000 more Wikipedia-derived topics total (~3MB extra download).",
    corpusPackIds: ["corpus-standard", "corpus-full"],
  },
  {
    id: "encyclopedia",
    label: "Encyclopedia",
    description: "Full, plus Wikipedia's ~50,000 Vital Articles (~164MB extra download).",
    corpusPackIds: ["corpus-standard", "corpus-full", "wiki-vital5"],
  },
];

export function totalManifestBytes(models: CatalogModel[]): number {
  return models.reduce((sum, m) => sum + m.sizeBytes, 0);
}

// A branch URL (resolve/main, raw/.../main/) can change under us: the file
// would then fail its sha256 check and block every install at setup.
const PINNED_SOURCE_URLS = [
  // Hugging Face model or dataset repo at a commit (packs live in subfolders).
  /^https:\/\/huggingface\.co\/(datasets\/)?[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/[^?#]+$/,
  /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//,
  // Release assets are addressed by tag; the sha256 check still guards them.
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/,
];

/** True when `url` points at an immutable revision (commit or release), never a branch. */
export function isPinnedSourceUrl(url: string): boolean {
  return PINNED_SOURCE_URLS.some((re) => re.test(url)) && !url.split("/").includes("..");
}

/** The name to show people: the short displayName of a model, else the asset's label. */
export function displayNameOf(asset: Pick<CatalogModel, "label" | "displayName">): string {
  return asset.displayName ?? asset.label;
}

