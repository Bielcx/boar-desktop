/**
 * One copy of an article's passage per answer. The bundled corpus, the downloaded packs and the large
 * Wikipedia packs each number their passages their own way, so retrieve() can't tell that "Vaccine"
 * from the bundled lead and "Vaccine" from a pack are the same text: both reached the prompt, and the
 * model read the same paragraph twice (X6 Pro, v1.1.0: 4 sources where v1.0.0 had 1 or 2, first token
 * 6-12 s instead of 1.5-6 s). Pure, so it's tested without the native modules.
 */

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** Consecutive word pairs: a copied paragraph shares most of them, another section of the same
 * article shares its vocabulary but few of its pairs. */
const pairs = (text: string): string[] => {
  const w = words(text);
  return w.slice(1).map((x, i) => `${w[i]} ${x}`);
};
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A later passage counts as a copy when this share of its word pairs is already in the earlier one. */
export const COPY_MIN_SHARE = 0.6;

/** Share of `b`'s word pairs (counted with repeats) that also appear in `a`. */
export function containedShare(a: string, b: string): number {
  const inA = new Set(pairs(a));
  const pb = pairs(b);
  if (!pb.length) return words(b).every((w) => words(a).includes(w)) ? 1 : 0;
  return pb.filter((p) => inA.has(p)).length / pb.length;
}

/**
 * Drops a passage when an earlier one has the same title and already holds most of its word pairs (either
 * way round: a pack's longer lead next to the bundled short one is a copy too). Two different sections
 * of one article stay. Order is kept; the first, best-ranked copy wins.
 */
export function dedupeArticleCopies<T extends { title: string; body: string }>(chunks: T[]): T[] {
  const kept: T[] = [];
  for (const c of chunks) {
    const copy = kept.some(
      (k) =>
        sameTitle(k.title, c.title) &&
        (containedShare(k.body, c.body) >= COPY_MIN_SHARE || containedShare(c.body, k.body) >= COPY_MIN_SHARE)
    );
    if (!copy) kept.push(c);
  }
  return kept;
}
