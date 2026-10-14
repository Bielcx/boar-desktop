/**
 * Layered-answer contract between the answer pipeline (src/routing/answer.ts)
 * and the chat UI. Agreed with the chat UI owner; spec mirrored in
 * docs/ADAPTIVE_ROUTING.md §"Answer contract".
 *
 * One pipeline, one event stream, whatever the depth: every answer is a
 * sequence of AnswerEvents delivered through a single onEvent callback, all
 * tagged with the answerId of the answer() call that produced them, so the UI
 * can drop late events from an answer it already stopped or replaced.
 *
 * Tiers (depth, not model):
 *   instant — extractive: a sentence from a retrieved source, no LLM, <1s.
 *   fast    — the model the user picked ("Use"), over compressed sources.
 *   deep    — the optional large model (settings deepModelId), or the
 *             multi-pass "complete answer" pipeline when no deep model fits.
 *
 * Pure types (no runtime deps) so UI code and tests can import it freely.
 */
import type { RetrievedChunk } from "../rag/retrieve.types";

export type AnswerTier = "instant" | "fast" | "deep";

export type AnswerStageName =
  | "loading_model"
  | "retrieving"
  | "prefill"
  | "generating"
  | "verifying"
  | "synthesizing";

export type AnswerOutcome = "success" | "stopped" | "timeout" | "interrupted" | "error";

export type AnswerErrorCode = "no_model" | "oom" | "load_failed" | "generation_failed" | "unknown";

export interface StageDetail {
  /** Sub-step position, e.g. sub-question 2 of 3 in a multi-pass answer. */
  index?: number;
  count?: number;
  /** 0..1 when measurable. Not emitted for prefill: llama.rn has no prompt-progress callback. */
  progress?: number;
  /** Multi-pass "retrieving" with index/count: the sub-question being researched (model-written text). */
  subQuestion?: string;
  /** Multi-pass "retrieving" with index/count: that sub-question's search is done and its sub-answer is being written. */
  answering?: boolean;
}

export interface AnswerReceipt {
  /** Catalog id of the model that wrote the answer, or "extractive" for the instant tier. */
  modelId: string;
  modelLabel: string;
  /** Generated tokens (0 for instant). */
  tokens: number;
  tokPerSec: number;
  /** From answer() to the first visible text (instant snippet or first token). */
  ttftMs: number;
  totalMs: number;
  retrievalMs?: number;
  /** Prompt processing time as measured by llama.cpp (timings.prompt_ms). */
  prefillMs?: number;
  /** Prompt tokens evaluated for the final generation (timings.prompt_n), after context compression. */
  ctxTokens?: number;
  /** Prompt tokens reused from the KV cache of the previous completion (llama.rn prefix reuse). */
  cachedTokens?: number;
  /** Model load time paid by this answer (0 when already resident). */
  loadMs?: number;
  /** Verification verdict, when a verify stage ran. */
  verification?: "passed" | "failed" | "uncertain";
  /** Short machine-readable routing decisions (debug surface). */
  reasonCodes: string[];
}

interface Base {
  answerId: string;
}

/** OpenStreetMap diet tag value (diet:vegan=only|yes|limited|no). */
export type PlaceDiet = "only" | "yes" | "limited" | "no";

/** A place from the offline POI pack. Every field comes from the record; nothing is generated. */
export interface Place {
  /** "osm:node/123" or "wikivoyage:<page>#<n>". */
  id: string;
  name: string;
  /** WGS84 decimal degrees. */
  lat: number;
  lon: number;
  /** OSM amenity: restaurant | cafe | fast_food | bar | ... */
  kind?: string;
  cuisine?: string[];
  diet?: Partial<Record<"vegan" | "vegetarian" | "gluten_free" | "halal" | "kosher", PlaceDiet>>;
  /** Only when the origin is the device position (GPS); never for "in <city>". */
  distanceM?: number;
  address?: string;
  /** OSM opening_hours, raw. */
  openingHours?: string;
  /** Shown as text, never opened (offline). */
  phone?: string;
  website?: string;
  /** Wikivoyage Eat/Drink text. */
  description?: string;
  source: "osm" | "wikivoyage";
  /** Index into the answer's sources[] ("[n]" = sourceIndex + 1). */
  sourceIndex?: number;
  /**
   * Doubtful diet tag (checked when the pack was built): "verify" = likely
   * wrong, listed last, show "OSM tag to verify"; "uncertain" = show the tag
   * without the strong diet badge. Absent = no doubt or not checked.
   */
  dietFlag?: "verify" | "uncertain";
}

export interface PlacesArea {
  kind: "near" | "city";
  /** "near you" / "perto de você", or the city name. */
  label?: string;
  origin?: { lat: number; lon: number; accuracyM?: number; ageS?: number };
  radiusM?: number;
  /**
   * Set when the area came from a city named in the question (or answer({ place })).
   * lat/lon: the city's point, once the gazetteer resolved it, so an empty
   * answer can offer the map covering it (tilesFor(lat, lon, km)).
   */
  place?: {
    name: string;
    /** The city as the question wrote it ("Roma" for the gazetteer's "Rome"), cleaned; the card shows this one. */
    asked?: string;
    country?: string;
    lat?: number;
    lon?: number;
  };
  /**
   * City areas only: true when a recent device fix (no new permission prompt,
   * no GPS wait) lies within DEVICE_INSIDE_RADIUS_M of the city center, so the
   * device clock is the city's clock (open/closed can be shown).
   */
  deviceInside?: boolean;
  /**
   * needs_place only: no fresh fix came, but an older one is known, in this
   * city. The UI offers "Use <city>" (answer({ query, place: city })) or "Choose a city".
   */
  lastKnown?: { city: string; country?: string; ageS: number };
}

/**
 * A source as shown. relevance (0..1): how well its best sentence answers the question,
 * on one scale for all sources of an answer; absent when there is no comparable measure
 * (a Deep Research answer, whose sub-questions each have their own). The UI normalizes
 * by the answer's maximum for the relevance bar and shows no bar without it.
 */
export type SourceChunk = RetrievedChunk & { relevance?: number };

export type AnswerEvent =
  | (Base & {
      type: "stage";
      stage: AnswerStageName;
      tier: AnswerTier;
      modelId?: string;
      detail?: StageDetail;
      /** performance.now() when the stage started. */
      at: number;
    })
  | (Base & {
      type: "sources";
      tier: AnswerTier;
      /**
       * Global, deduplicated, stable numbering: "[n]" in the answer text refers to sources[n - 1].
       * A multi-pass answer sends one after each sub-question that found new sources: each list is
       * the previous one plus new sources at the end (numbers never change); the last is the final list.
       */
      sources: SourceChunk[];
    })
  | (Base & {
      type: "instant";
      snippet: { text: string; sourceIndex: number };
      /** 0..1. At or above INSTANT_FINAL_CONFIDENCE on a lookup, the snippet may be the final answer. */
      confidence: number;
    })
  | (Base & { type: "token"; tier: AnswerTier; text: string })
  | (Base & {
      type: "done";
      tier: AnswerTier;
      outcome: AnswerOutcome;
      receipt: AnswerReceipt;
      /** kind: why a model load failed (inference/loadError.ts), for the chat's card; the message has no RAM hint. */
      error?: { code: AnswerErrorCode; message: string; kind?: "memory" | "engine" | "corrupt" | "missing" };
      /**
       * The answer text to show when it differs from the streamed tokens: citations
       * the sources don't support were removed (CT-1). The UI replaces the text.
       */
      finalText?: string;
      /**
       * Source numbers ([n], 1-based into the sources event) the final answer text cites, after
       * unsupported citations were dropped (CT-1). Empty: the answer rests on no source, so the
       * chat shows no "Sources" card (at most a collapsed "Related in your library"; Prism CT-2).
       */
      cited?: number[];
      /**
       * A health, first-aid or disaster question (the engine's classifier): the chat
       * shows the "Not a substitute for emergency services" line.
       */
      safety?: boolean;
    })
  | (Base & {
      /** Emitted only after a fast-tier done: a deeper answer is possible for this question. */
      type: "deep_available";
      reason?: string;
      estSeconds?: number;
    })
  | (Base & {
      /** Device position lookup for a "near me" question. "prompt"/"denied": the UI asks for permission in context, or for a city. */
      type: "location";
      /**
       * locating: no fix of 5 minutes or less is cached; waiting up to LOCATION_WAIT_MS for one
       * (the UI offers "Type the city" meanwhile). stale: none came; ageS is the last fix's age.
       */
      status: "granted" | "denied" | "unavailable" | "stale" | "prompt" | "locating";
      accuracyM?: number;
      ageS?: number;
    })
  | (Base & {
      /**
       * Places answer, already ranked (the UI must not reorder): by diet tag
       * strength (only > yes > limited) then distance when criterion is
       * "diet_match", by distance when "distance". Emitted before any
       * model token; for now the whole answer (done tier "instant",
       * receipt.modelId "places").
       */
      type: "places";
      tier: AnswerTier;
      places: Place[];
      area: PlacesArea;
      /** Requested filters, e.g. ["vegan"]. */
      filters?: string[];
      /** How "best" was decided; popularity is never claimed. */
      criterion: "distance" | "diet_match";
      /** ok: places listed. none: nothing listed (see empty). no_pack: POI pack not installed. needs_place: no location and no city named. */
      coverage: "ok" | "none" | "no_pack" | "needs_place";
      /**
       * coverage "none" only, why: no_data = no installed map covers the area
       * (or the city is unknown); no_match = a map covers it, but no record
       * matches the filters within area.radiusM (the data exists).
       */
      empty?: "no_data" | "no_match";
      truncated?: boolean;
      /** Required attribution (ODbL for OpenStreetMap, CC BY-SA for Wikivoyage). */
      attribution: { source: "osm" | "wikivoyage"; date?: string; license: string }[];
    })
  | (Base & {
      /** A model loaded but its weights stream from storage (see src/inference/memoryFit.ts). */
      type: "warning";
      /** weak_sources: no retrieved source covers the question well; show the sources as weak and suggest a knowledge pack. */
      code: "model_streams_from_storage" | "weak_sources";
      message: string;
      /**
       * weak_sources only: true = the compact model did NOT answer (it would answer
       * from memory); the done that follows has no text. The UI offers "Answer
       * anyway": answer({ query, answerAnyway: true }).
       */
      declined?: boolean;
    });

export type AnswerEventHandler = (e: AnswerEvent) => void;

export interface AnswerRequest {
  query: string;
  /**
   * "auto" (default): the router picks the depth from settings
   * (answerQuickFirst / answerAlwaysComplete) and the question.
   * "fast"/"deep": force a tier (deep = the "Deeper answer" button).
   */
  tier?: "auto" | "fast" | "deep";
  /** For deepen(): reuse the sources of this earlier answer instead of retrieving again. */
  reuseSources?: RetrievedChunk[];
  /** City the user typed after a "which city?" prompt (location denied/unavailable). */
  place?: string;
  /** "Answer anyway" after a declined weak_sources: the compact model answers from memory, with the notice. */
  answerAnyway?: boolean;
  /** "Ask this document": search only these personal collections (no bundled corpus, no packs, no places). */
  collections?: string[];
}

export interface AnswerResult {
  answerId: string;
  tier: AnswerTier;
  outcome: AnswerOutcome;
  text: string;
  sources: RetrievedChunk[];
  receipt: AnswerReceipt;
  /** See the done event's cited. */
  cited?: number[];
}

export interface AnswerHandle {
  answerId: string;
  /** Stops the running answer; resolves once the model has actually stopped. */
  stop(): Promise<void>;
  done: Promise<AnswerResult>;
}
