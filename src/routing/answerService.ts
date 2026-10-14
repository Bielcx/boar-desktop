/**
 * The layered answer pipeline wired to the real engine, retrieval and
 * settings. This is what the chat UI imports:
 *
 *   const h = answer({ query }, onEvent, { systemPrompt, styleReminder, history, maxTokens });
 *   h.stop(); await h.done;
 *   deepen(query, previousSources, onEvent, ctx);
 *
 * See src/routing/events.ts for the event contract and
 * docs/ADAPTIVE_ROUTING.md for the routing rules.
 */
import { defaultContextSize, llamaEngine } from "../inference/LlamaEngine";
import { Platform } from "react-native";
import { getDeviceTotalRamBytes, getMemoryInfo } from "ram-monitor";
import { retrieve } from "../rag/retrieve";
import { englishNamesIn } from "../rag/ptLexicon";
import { ptLexicon } from "../rag/ptLexiconAsset";
import { seedKnowledgeBaseIfEmpty } from "../rag/seedCorpus";
import { answerPromptPrefix, assemblePrompt, assembleChatMessages } from "../rag/pure";
import { ModelManager } from "../models/ModelManager";
import { MODEL_CATALOG } from "../models/manifest";
import { listDiscoveredModels } from "../models/discoveredModels";
import { getActiveModelId, getAnswerSettings, getCustomSystemPrompt, getPersonalityId } from "../models/settings";
import { getPersonality } from "../constants/personalities";
import { runDeepResearch } from "../services/orchestrator";
import { createAnswerer, InstalledLlm } from "./answer";
import { measuredSpeeds } from "./depth";
import { listRecentExecutions, recordExecution } from "../services/executionTelemetry";
import type { GeoProviders } from "./geo";

let geoProviders: GeoProviders | null = null;

/**
 * Plugs in offline places: the POI pack (src/rag/pois.ts: resolvePlace,
 * searchPois) and device location (src/services/location.ts, which must not
 * prompt for permission). Called once by the app shell when both exist;
 * until then places questions answer "places pack not installed".
 */
export function registerGeoProviders(p: GeoProviders | null): void {
  geoProviders = p;
}

async function listInstalledLlms(): Promise<InstalledLlm[]> {
  // Models picked from the Hugging Face browser live in discoveredModels, not MODEL_CATALOG.
  const catalog = [...MODEL_CATALOG, ...(await listDiscoveredModels().catch(() => []))].filter((m) => m.kind === "llm");
  const statuses = await new ModelManager(catalog).statusAll();
  return statuses
    .filter((s) => s.present)
    .map((s) => ({
      id: s.asset.id,
      label: s.asset.label,
      filename: s.asset.filename,
      sizeBytes: s.asset.sizeBytes,
      roles: s.asset.capabilities?.roles ?? [],
      isDefault: s.asset.required,
      // Catalog field added with the Qwen3-4B default (trust branch); absent on older catalogs.
      answerTier: (s.asset as { answerTier?: "default" | "compact" }).answerTier,
    }));
}

/**
 * The knowledge base indexed, once per session: joins (or starts) the seed run the chat starts
 * after the models load, so a question asked during the first boot's indexing waits for it.
 * Later questions don't re-read the corpus packs; a new pack is indexed by the chat as before.
 */
let knowledgeIndexed: Promise<void> | null = null;
function knowledgeReady(): Promise<void> {
  knowledgeIndexed ??= seedKnowledgeBaseIfEmpty().catch((e) => {
    knowledgeIndexed = null; // retry on the next question
    console.warn("[answer] knowledge indexing failed:", e?.message ?? e);
  });
  return knowledgeIndexed;
}

export const { answer, deepen, effectiveModel: effectiveAnswerModel } = createAnswerer({
  engine: llamaEngine,
  retrieve: (q, k, collections) => retrieve(q, k, { collections }),
  knowledgeReady,
  englishNames: (query) => englishNamesIn(query, ptLexicon()),
  getSettings: getAnswerSettings,
  listInstalledLlms,
  getActiveModelId: () => getActiveModelId("llm"),
  runMultipass: runDeepResearch,
  assemblePrompt,
  assembleChatMessages,
  answerPrefix: answerPromptPrefix,
  now: () => performance.now(),
  contextSize: defaultContextSize,
  deviceRamBytes: () => {
    try {
      return getDeviceTotalRamBytes();
    } catch {
      return 0;
    }
  },
  getGeoProviders: () => geoProviders,
  getModelSpeeds: async () => measuredSpeeds(await listRecentExecutions(500)),
  recordExecution,
  // iOS: the footprint (jetsam's figure; RSS counts clean mmap'd weights); the native module names it totalPssBytes.
  memoryBytes: () => {
    const m = getMemoryInfo();
    return Platform.OS === "ios" ? m.totalPssBytes : m.rssBytes;
  },
});

// The first question after launch: the saved tone's prompt prefix is prefilled as soon as the model loads
// (ChatScreen builds its system prompt the same way). Later answers keep it current.
Promise.all([getPersonalityId(), getCustomSystemPrompt()])
  .then(([id, custom]) => llamaEngine.setAnswerPrefix(answerPromptPrefix(id === "custom" ? custom : getPersonality(id).systemPrompt)))
  .catch((e) => console.warn("[answer] tone for the prompt prefix:", e?.message ?? e));
