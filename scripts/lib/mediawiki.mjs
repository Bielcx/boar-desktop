// MediaWiki API helpers for topic-pack fetchers (build time only): category
// crawls, prefix listings, page wikitext in batches, and wikitext → pack text.
import { cleanWikivoyage } from "./wiki-pack-lib.mjs";

export const UA = "BOAR-pack-builder/0.1 (https://github.com/rferrari/boar-app)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries on rate limiting (429, 5xx, or an HTML error page where JSON was expected). */
export async function get(url, { json = true, attempt = 0 } = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const body = await res.text();
  const limited = res.status === 429 || res.status >= 500 || (json && !body.trimStart().startsWith("{"));
  if (limited && attempt < 6) {
    await sleep(5000 * 2 ** attempt);
    return get(url, { json, attempt: attempt + 1 });
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return json ? JSON.parse(body) : body;
}

// Headings in the pack are markdown ("## Treatment"); cleanWikivoyage already writes them.
export const SKIP_SECTIONS = /\n#{2,3} (See also|References|Notes|Footnotes|External links|Further reading|Bibliography|Sources)\s*\n[\s\S]*$/;
export function wikiText(title, wikitext) {
  const body = cleanWikivoyage(wikitext).replace(SKIP_SECTIONS, "").trim();
  return `# ${title}\n\n${body}`;
}

export async function categoryPages(api, roots, depth) {
  const pages = new Set();
  const seenCats = new Set();
  let frontier = roots.map((c) => `Category:${c}`);
  for (let d = 0; d <= depth && frontier.length; d++) {
    const next = [];
    for (const cat of frontier) {
      if (seenCats.has(cat)) continue;
      seenCats.add(cat);
      let cont = {};
      do {
        const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", list: "categorymembers", cmtitle: cat, cmlimit: "500", cmtype: "page|subcat", ...cont });
        const j = await get(`${api}?${q}`);
        for (const m of j.query.categorymembers) {
          if (m.ns === 14) next.push(m.title);
          else if (m.ns === 0) pages.add(m.title);
        }
        cont = j.continue ?? null;
        await sleep(300);
      } while (cont);
    }
    frontier = next;
  }
  return [...pages];
}

export async function prefixPages(api, prefixes) {
  const pages = [];
  for (const p of prefixes) {
    let cont = {};
    do {
      const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", list: "allpages", apprefix: p, aplimit: "500", apfilterredir: "nonredirects", ...cont });
      const j = await get(`${api}?${q}`);
      pages.push(...j.query.allpages.map((x) => x.title));
      cont = j.continue ?? null;
      await sleep(300);
    } while (cont);
  }
  return pages;
}

/** Wikitext of up to 50 pages per request; redirects followed (their titles in `aliases`), missing pages skipped. */
export async function* wikitexts(api, titles) {
  for (let i = 0; i < titles.length; i += 50) {
    const q = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", prop: "revisions|info", rvprop: "content|ids", rvslots: "main",
      inprop: "url", redirects: "1", titles: titles.slice(i, i + 50).join("|"),
    });
    const j = await get(`${api}?${q}`);
    const aliases = new Map();
    for (const r of j.query.redirects ?? []) aliases.set(r.to, [...(aliases.get(r.to) ?? []), r.from]);
    for (const p of j.query.pages ?? []) {
      const rev = p.revisions?.[0];
      if (p.missing || !rev) continue;
      yield { id: p.pageid, title: p.title, url: p.fullurl, revid: rev.revid, wikitext: rev.slots.main.content, aliases: aliases.get(p.title) ?? [] };
    }
    await sleep(1000);
  }
}
