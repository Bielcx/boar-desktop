/**
 * The sources under an answer, one per article (the native app's SourceGroups): passages of the same article become
 * one entry with the best score, listed best first. The answer's [n] citations are renumbered to match, so a number
 * still points at its passage's article.
 */
export interface Grouped<T> {
  items: T[];
  /** Each old 1-based number's new one. */
  renumber: Map<number, number>;
}

const URL = /https?:\/\/[^\s)]+/;

/**
 * Which article a passage belongs to: its page URL when the source names one, so the same article from two packs is
 * one source; else its document id; else its title.
 */
export function articleKey(c: { source?: string; docId?: string; title: string }): string {
  return c.source?.match(URL)?.[0] ?? (c.docId || c.title);
}

/**
 * One entry per article, best article first; equal scores keep the order the model read them in. The entry is the
 * best passage with every passage's text, best first, so a renumbered [n] still points at the text it cited.
 */
export function groupSources<T extends { source?: string; docId?: string; title: string; body: string }>(
  passages: T[],
  score: (p: T) => number | undefined
): Grouped<T> {
  const byKey = new Map<string, { p: T; i: number }[]>();
  passages.forEach((p, i) => {
    const k = articleKey(p);
    byKey.set(k, [...(byKey.get(k) ?? []), { p, i }]);
  });
  const s = (p: T) => score(p) ?? Number.NEGATIVE_INFINITY;
  const best = (g: { p: T }[]) => Math.max(...g.map((x) => s(x.p)));
  const groups = [...byKey.values()].map((g, order) => ({ g, order })).sort((a, b) => best(b.g) - best(a.g) || a.order - b.order);
  const renumber = new Map<number, number>();
  const items = groups.map(({ g }, n) => {
    for (const x of g) renumber.set(x.i + 1, n + 1);
    const ps = g.map((x) => x.p).sort((a, b) => s(b) - s(a));
    return ps.length === 1 ? ps[0] : { ...ps[0], body: ps.map((p) => p.body).join("\n\n") };
  });
  return { items, renumber };
}

const CITE = /\[(\d{1,4})\]/g;
const REPEATED = /\[(\d{1,4})\]((?:[ \t]*\[\1\])+)/g;

/** "[3] … [1][2]" with 1 and 2 merged: "[1] … [2]". Numbers it doesn't know are left as written. */
export function renumberCitations(text: string, map: Map<number, number>): string {
  if ([...map].every(([k, v]) => k === v)) return text;
  return text.replace(CITE, (m, n) => (map.has(+n) ? `[${map.get(+n)}]` : m)).replace(REPEATED, "[$1]");
}
