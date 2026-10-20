/**
 * The measured facts of one answer, shown in its footer once it finishes (the native app's Receipt.kt, which follows
 * main's AnswerReceipt). Kept in the message's meta (chat_message_meta), so a reopened chat still shows it.
 */
export interface Receipt {
  /** From the question being sent to the last token. */
  totalMs: number;
  /** From the question being sent to the first token: search, reading the sources and the prompt. */
  ttftMs: number;
  /** Generation speed. */
  tokPerSec: number;
  tokens: number;
  model?: string;
  /** The answer style it was written in (a health question answers in Succinct whatever was picked); absent on older answers. */
  style?: string;
  /** How it was answered: absent for the normal answer, "deep" (Deep Research), "chat" (written from this chat), "adaptive". */
  path?: "deep" | "chat" | "adaptive";
  /** Why BOAR answered in Succinct when Detailed was picked ("health", "seed"); absent when it used the pick. */
  styleNote?: "health" | "seed";
}

/** Why an answer failed, a chatScreen.* key: kept in the message's meta, so it stays under the answer (native fc1711a2). */
export type ChatError = "errorNoModel" | "errorGeneric" | "errorEmpty";

/** The failure stored with a message; null when it has none. */
export function errorFromMeta(meta: string | null): ChatError | null {
  if (!meta) return null;
  try {
    const e = JSON.parse(meta)?.error;
    return e === "errorNoModel" || e === "errorGeneric" || e === "errorEmpty" ? e : null;
  } catch {
    return null;
  }
}

/** "9.1 s" under a minute, "2 min 5 s" above. */
export function formatSeconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** About 0.75 English words per token. */
export function approxWords(tokens: number): number {
  return Math.round(tokens * 0.75);
}

/** The receipt out of a message's stored meta; null when there is none or it doesn't parse. */
export function receiptFromMeta(meta: string | null): Receipt | null {
  if (!meta) return null;
  try {
    const r = JSON.parse(meta)?.receipt;
    return r && typeof r.totalMs === "number" && typeof r.tokPerSec === "number" ? r : null;
  } catch {
    return null;
  }
}
