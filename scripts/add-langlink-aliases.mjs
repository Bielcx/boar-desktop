#!/usr/bin/env node
// Adds another language's names for a pack's Wikipedia articles as aliases, so
// a question in that language resolves the English article by name
// ("queimadura" -> Burn, "primeiros socorros" -> First aid). Names come from
// Wikipedia itself: the interlanguage link of each article (the same article
// on pt.wikipedia) and that article's redirects there. They go into the pack's
// redirects table; an alias that is another article's title in the pack is
// skipped. Build time only (Wikipedia API, polite rate).
//
//   node scripts/add-langlink-aliases.mjs --pack boar-preparedness.sqlite --lang pt --out boar-preparedness-pt.sqlite
import { copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { get } from "./lib/mediawiki.mjs";

const { values: o } = parseArgs({ options: { pack: { type: "string" }, lang: { type: "string", default: "pt" }, out: { type: "string" } } });
if (!o.pack || !o.out) throw new Error("usage: add-langlink-aliases.mjs --pack IN.sqlite --lang pt --out OUT.sqlite");
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EN = "https://en.wikipedia.org/w/api.php";
const TARGET = `https://${o.lang}.wikipedia.org/w/api.php`;

/** All pages of a batched query, following "continue". */
async function query(api, params) {
  const pages = [];
  let cont = {};
  do {
    const j = await get(`${api}?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params, ...cont })}`);
    pages.push(...(j.query?.pages ?? []));
    cont = j.continue ?? null;
    await sleep(300);
  } while (cont);
  return pages;
}

copyFileSync(o.pack, o.out);
const db = new DatabaseSync(o.out);
// Source 0 = enwiki (scripts/build-wiki-pack.mjs SOURCE).
const articles = db.prepare("SELECT id, title FROM articles WHERE source = 0").all();
const idOf = new Map(articles.map((a) => [a.title, a.id]));
const titleOwner = new Map(db.prepare("SELECT lower(title) AS t, id FROM articles").all().map((r) => [r.t, r.id]));
log(`${articles.length} Wikipedia articles`);

// 1. English title -> title of the same article in the target language.
const target = new Map(); // target title -> pack article id
for (let i = 0; i < articles.length; i += 50) {
  const pages = await query(EN, { prop: "langlinks", lllang: o.lang, lllimit: "max", titles: articles.slice(i, i + 50).map((a) => a.title).join("|") });
  for (const p of pages) {
    const ll = p.langlinks?.[0]?.title;
    const id = idOf.get(p.title);
    if (ll && id !== undefined) target.set(ll, id);
  }
}
log(`${target.size} articles have a ${o.lang} counterpart`);

// 2. Redirects to those articles on the target wiki (other names for the same thing).
const aliases = new Map([...target].map(([t, id]) => [t, id]));
const titles = [...target.keys()];
for (let i = 0; i < titles.length; i += 50) {
  const pages = await query(TARGET, { prop: "redirects", rdnamespace: "0", rdlimit: "max", titles: titles.slice(i, i + 50).join("|") });
  for (const p of pages) {
    const id = target.get(p.title);
    if (id === undefined) continue;
    for (const r of p.redirects ?? []) if (!aliases.has(r.title)) aliases.set(r.title, id);
  }
}

// 3. Into the redirects table, never over another article's own title.
const ins = db.prepare("INSERT OR IGNORE INTO redirects (title, article_id) VALUES (?, ?)");
let added = 0;
let clashes = 0;
db.exec("BEGIN");
for (const [title, id] of aliases) {
  const owner = titleOwner.get(title.toLowerCase());
  if (owner !== undefined && owner !== id) {
    clashes++;
    continue;
  }
  if (ins.run(title, id).changes) added++;
}
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`aliases_${o.lang}`, String(added));
db.exec("COMMIT");
db.exec("VACUUM");
db.close();
log(`${o.lang} aliases: ${added} added (${aliases.size} names, ${clashes} skipped: another article's title)`);
