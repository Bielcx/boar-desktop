import { isHealthQuestion, isSeedPhraseQuestion } from "../routing/context";
import { classifyTask } from "../routing/classify";

export type PersonalityId = "succinct" | "detailed" | "summary" | "custom";

export interface Personality {
  id: PersonalityId;
  label: string;
  icon: string;
  description: string;
  /** System prompt text; unused for "custom" (user supplies their own via settings). */
  systemPrompt: string;
  /**
   * Appended to the current question. Small models follow what's closest to the
   * question: the system prompt alone gets buried under ~2,000 characters of
   * retrieved context. Tested with Qwen2.5-1.5B: only here did "summary" produce
   * its takeaway and bullets, and "detailed" answers got about 70% longer.
   */
  styleReminder?: string;
  /**
   * For a small answer model (under SMALL_MODEL_BYTES): Detailed without D4's "Always do what the user asks", which made
   * the 1.5B follow first-aid asks with wrong steps in r4to's engine tests (the native app's 70accb9d, Oct 18).
   */
  systemPromptSmall?: string;
  styleReminderSmall?: string;
}

/** Models smaller than this file size are "small" for promptFor (Qwen2.5 1.5B is 1.0 GB, Qwen3 4B 2.5 GB). */
export const SMALL_MODEL_BYTES = 2_000_000_000;

/**
 * Response-style presets. Local models on phone hardware default to long,
 * meandering answers — extra output length means more latency and battery
 * drain, not more usefulness. These give the user direct control over
 * answer length/style without editing prompts by hand.
 */
export const PERSONALITIES: Personality[] = [
  {
    id: "succinct",
    label: "Succinct & Direct",
    icon: "⚡",
    description: "Fastest — 2–3 brief paragraphs, no preamble.",
    // Small instruct models default heavily toward a "one-sentence takeaway,
    // then 3 bullet points" shape for almost any "be concise" instruction —
    // that's a real, common tendency, not a bug in personality selection
    // (getPersonalityId() is read fresh from persisted settings at both the
    // header and generate() call, single source of truth, no desync). The
    // original wording here explicitly allowed "bullet points", with
    // nothing distinguishing it from "summary"'s deliberately stricter
    // 1-sentence+3-bullets template below — the two ended up looking the
    // same in practice. This is now prose-first and explicitly steers away
    // from mimicking that specific shape, reserving it for "summary".
    systemPrompt:
      "You are Boar, a concise offline research assistant. Answer in 2-3 short, direct " +
      "sentences or a brief paragraph, no preamble. Do not default to a bulleted list " +
      "or a single takeaway sentence followed by three bullet points — use bullets only " +
      "when the content is genuinely a list of distinct items.",
    styleReminder: "Keep it short: 2-3 sentences. No lists unless the question asks for one.",
  },
  {
    // Deliberately not called "Deep Research" or using 🔬 — that name/icon
    // is reserved for the actual multi-pass "Deep Research Mode" toggle
    // (src/services/orchestrator.ts), a different, independent feature.
    // Using both for this single-pass response-style preset was confusing:
    // turning on Deep Research Mode is NOT the same as picking this style,
    // and vice versa (they compose — Deep Research Mode still uses
    // whichever style is selected here for its synthesis step).
    id: "detailed",
    label: "Thorough & Detailed",
    icon: "📚",
    description: "Structured, in-depth answers on what it knows well.",
    // r4to's D4 wording (the native app's 42456919): depth only on what it knows, no invented figures or names.
    systemPrompt:
      "You are Boar, an analytical research partner. Provide thorough, structured explanations. Explain in depth what " +
      "you know well, up to 3–5 paragraphs. Leave out figures and names you are not sure of. State only facts you are " +
      "sure of. Never invent names, numbers, dates, places or quotes. If you don't know, say so in one sentence. A " +
      "shorter correct answer beats a longer one. This rule covers facts only. Always do what the user asks: write " +
      "code, give examples, make tables, and calculate from numbers given in the question.",
    styleReminder:
      "Be thorough: 3-5 paragraphs that cover the key points in depth. Leave out figures and names you are not sure " +
      "of. Don't repeat yourself.",
    systemPromptSmall:
      "You are Boar, an analytical research partner. Provide thorough, structured explanations. Explain in depth what " +
      "you know well, up to 3–5 paragraphs. Leave out examples, figures and names you are not sure of. State only " +
      "facts you are sure of. Never invent names, numbers, dates, places or quotes. If you don't know, say so in one " +
      "sentence. A shorter correct answer beats a longer one.",
    styleReminderSmall:
      "Be thorough: 3-5 paragraphs that cover the key points in depth. Leave out examples, figures and names you are " +
      "not sure of. Don't repeat yourself.",
  },
  {
    id: "summary",
    label: "Executive Summary",
    icon: "📋",
    description: "One top-line takeaway, then 3 key bullet points.",
    systemPrompt:
      "You are Boar. Provide a 1-sentence top-line key takeaway followed by 3 short bullet " +
      "points summarizing the answer.",
    styleReminder:
      "Use exactly this format and nothing else:\n" +
      "<one-sentence key takeaway>\n- <point 1>\n- <point 2>\n- <point 3>",
  },
  {
    id: "custom",
    label: "Custom",
    icon: "⚙️",
    description: "Write your own system prompt.",
    systemPrompt: "",
  },
];

/** Detailed, as the native app (its personalities.json defaultId). */
export const DEFAULT_PERSONALITY_ID: PersonalityId = "detailed";

export const MAX_TOKENS_OPTIONS = [256, 512, 1024, 2048] as const;

/**
 * The styles offered in Settings, the style sheet and Profiles. Custom is hidden (the native app's 4ed5037f): a prompt
 * the user writes could make BOAR say anything, and a screenshot of it would pass as BOAR's own words. It still works
 * where it's already chosen, and stays listed there so it can be switched away from.
 */
export function offeredStyles(current?: PersonalityId): Personality[] {
  return PERSONALITIES.filter((p) => p.id !== "custom" || current === "custom");
}

export function getPersonality(id: PersonalityId): Personality {
  return PERSONALITIES.find((p) => p.id === id) ?? PERSONALITIES[0];
}

/** A style's system prompt and reminder; a small answer model gets the style's small-model texts where it has them. */
export function promptFor(p: Personality, smallModel: boolean): { systemPrompt: string; styleReminder?: string } {
  return smallModel && p.systemPromptSmall
    ? { systemPrompt: p.systemPromptSmall, styleReminder: p.styleReminderSmall }
    : { systemPrompt: p.systemPrompt, styleReminder: p.styleReminder };
}

/** Why a question picked under Detailed is answered in Succinct: a health or seed-phrase question, or small talk. */
export type ShortReason = "health" | "seed" | "smalltalk";

/** A thank-you or greeting ("thanks, that helps"): Succinct's length, not a Detailed essay (the native app, X6, Oct 18). */
export const isSmallTalk = (question: string) => classifyTask(question) === "greeting";

const reasonFor = (q: string): ShortReason | null => (isHealthQuestion(q) ? "health" : isSeedPhraseQuestion(q) ? "seed" : null);

/**
 * Why Detailed answers short (the native app's ShortAnswer): a health or first-aid question (a sentence-level audit of
 * 15 Detailed answers, r4to, Oct 17, found 20 % of claims wrong, 5 of them safety errors), a seed-phrase question (a
 * wrong detail loses the coins), or small talk. A follow-up in such a chat counts too ("and for how long?" after a
 * burn question). Null: the pick stands.
 */
export function shortAnswerReason(chosen: PersonalityId, question: string, previousQuestion?: string): ShortReason | null {
  if (chosen !== "detailed") return null;
  // Before the follow-up check: "thanks" after a burn question is small talk, not first aid.
  if (isSmallTalk(question)) return "smalltalk";
  return reasonFor(question) ?? (previousQuestion ? reasonFor(previousQuestion) : null);
}

/** The style an answer is written in: Succinct when Detailed has a reason to answer short. */
export function answerStyleFor(chosen: PersonalityId, question: string, previousQuestion?: string): PersonalityId {
  return shortAnswerReason(chosen, question, previousQuestion) ? "succinct" : chosen;
}
