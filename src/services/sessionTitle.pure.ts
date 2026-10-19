/**
 * A small model asked to title "How long should I boil river water at Camp Tamandua?" sometimes answers it instead
 * ("Boil for 10 minutes"), and the sidebar then shows a made-up fact next to the sourced answer. A title has to be
 * made of the question: no number the question doesn't have, and at least one of its words or numbers. Otherwise
 * the question itself is the title.
 */
const words = (s: string) => s.toLowerCase().match(/\p{L}{4,}/gu) ?? [];
const numbers = (s: string) => s.match(/\d+(?:[.,]\d+)?/g) ?? [];

export function questionTitle(query: string): string {
  const q = query.trim().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
  return q.length > 60 ? q.slice(0, 59).replace(/\s+\S*$/, "") + "…" : q || "New chat";
}

export function sessionTitleFor(generated: string, query: string): string {
  const title = generated.trim();
  const qWords = new Set(words(query));
  const qNumbers = new Set(numbers(query));
  const madeUpNumber = numbers(title).some((n) => !qNumbers.has(n));
  const sharesSomething = words(title).some((w) => qWords.has(w)) || numbers(title).some((n) => qNumbers.has(n));
  return title && !madeUpNumber && sharesSomething ? title : questionTitle(query);
}

/**
 * A title a reasoning model wrote as "<think>…" before titles skipped the thinking (fixed Oct 16): the thinking
 * dropped, else the chat's first question; null when the title needs no repair.
 */
export function repairedTitle(title: string, firstQuestion: string | undefined): string | null {
  if (!title.includes("<think") && !title.includes("</think>")) return null;
  const kept = title.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/<\/?think>/g, "").trim();
  return kept || (firstQuestion ? questionTitle(firstQuestion) : "New chat");
}
