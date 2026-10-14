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
