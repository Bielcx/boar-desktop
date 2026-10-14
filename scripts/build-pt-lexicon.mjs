#!/usr/bin/env node
// Builds the Portuguese -> English name lexicon the app uses to search English sources with a Portuguese
// question ("estações do ano" -> Season). Names come from Wikipedia itself: for each English title, the title
// of the same article on pt.wikipedia (interlanguage link) and, optionally, that article's Portuguese redirects.
// Keys are normalized (lower case, no accents, no trailing "(…)"). When two names share a key, an exact Portuguese
// title beats a title with a "(…)" qualifier, which beats a redirect ("São Paulo" is the city, not "São Paulo
// (apóstolo)"). A one-word key comes from an exact title or a redirect of 8+ letters: "assinatura" isn't
// "Assinatura (lógica)", "terremoto" is Earthquake. A name with accents also gets its accented key, and on the
// accent-free key a name written without accents wins ("romã" -> Pomegranate, "roma" -> Rome).
// Build time only.
//
//   node scripts/build-pt-lexicon.mjs --titles titles.txt --out assets/lexicon/pt-en.json [--redirects]
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { get } from "./lib/mediawiki.mjs";

const { values: o } = parseArgs({ options: { titles: { type: "string" }, out: { type: "string" }, redirects: { type: "boolean", default: false } } });
if (!o.titles || !o.out) throw new Error("usage: build-pt-lexicon.mjs --titles titles.txt --out pt-en.json [--redirects]");
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const normalizeKey = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();

async function pages(api, params) {
  const out = [];
  let cont = {};
  do {
    const j = await get(`${api}?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params, ...cont })}`);
    out.push(...(j.query?.pages ?? []));
    cont = j.continue ?? null;
    await sleep(200);
  } while (cont);
  return out;
}

const titles = [...new Set(readFileSync(o.titles, "utf8").split("\n").map((t) => t.trim()).filter(Boolean))];
log(`${titles.length} English titles`);
const ptOf = new Map(); // pt title -> en title
for (let i = 0; i < titles.length; i += 50) {
  for (const p of await pages("https://en.wikipedia.org/w/api.php", { prop: "langlinks", lllang: "pt", lllimit: "max", redirects: "1", titles: titles.slice(i, i + 50).join("|") })) {
    const pt = p.langlinks?.[0]?.title;
    if (pt && !p.missing) ptOf.set(pt, p.title);
  }
  if (i % 5000 === 0) log(`langlinks ${i}/${titles.length}: ${ptOf.size}`);
}
log(`${ptOf.size} titles have a Portuguese article`);

const lexicon = new Map(); // key -> { en, rank }: 3 exact title, 2 title with a "(…)" qualifier, 1 redirect
// Lower case with accents kept, qualifier dropped: "romã" and "roma" are different words.
const accentKey = (s) => s.normalize("NFC").toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
const put = (name, en, rank) => {
  const k = normalizeKey(name);
  // One-word names: exact titles, or long redirects ("terremoto" -> Earthquake, whose title is "Sismo"); short
  // one-word redirects are too often another sense ("assinatura" -> Signature (logic)).
  if (k.length < 3 || (!k.includes(" ") && rank < 3 && k.length < 8)) return;
  const accented = accentKey(name);
  // On the accent-free key, a name written without accents beats one that only folds to it ("Roma" -> Rome, not
  // "Romã" -> Pomegranate); the accented spelling keeps its own key.
  const r = rank * 2 + (accented === k ? 1 : 0);
  if ((lexicon.get(k)?.rank ?? 0) < r) lexicon.set(k, { en, rank: r });
  if (accented !== k && (lexicon.get(accented)?.rank ?? 0) < r) lexicon.set(accented, { en, rank: r });
};
for (const [pt, en] of ptOf) put(pt, en, /\(/.test(pt) ? 2 : 3);
if (o.redirects) {
  const pts = [...ptOf.keys()];
  for (let i = 0; i < pts.length; i += 50) {
    for (const p of await pages("https://pt.wikipedia.org/w/api.php", { prop: "redirects", rdnamespace: "0", rdlimit: "max", titles: pts.slice(i, i + 50).join("|") })) {
      const en = ptOf.get(p.title);
      if (!en) continue;
      for (const r of p.redirects ?? []) if (r.title.length <= 60 && !/^\d/.test(r.title)) put(r.title, en, 1);
    }
    if (i % 5000 === 0) log(`redirects ${i}/${pts.length}: ${lexicon.size}`);
  }
}
const obj = Object.fromEntries([...lexicon].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.en]));
writeFileSync(o.out, JSON.stringify(obj));
log(`${lexicon.size} Portuguese names -> ${o.out}`);
