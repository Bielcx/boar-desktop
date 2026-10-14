// Pure helpers for the crypto knowledge pack (scripts/fetch-crypto.mjs):
// front matter, markdown and LaTeX → pack text, EIP/ERC/BIP documents with
// their aliases, and the BIP license check. Build time only.
import { cleanWikivoyage } from "./wiki-pack-lib.mjs";

/** YAML-ish front matter ("key: value" lines between --- fences) → [fields, body]. Lists and nesting are ignored. */
export function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return [{}, text];
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return [fields, text.slice(m[0].length)];
}

/**
 * Markdown (GitHub/MDX flavour) → pack text: headings stay markdown, links keep
 * their text, images, HTML/JSX tags, heading anchors ("{#id}") and comments go.
 * Fenced code stays (specs define constants and containers in it).
 */
export function cleanMarkdown(md) {
  const parts = md.replace(/<!--[\s\S]*?-->/g, "").split(/(^```[\s\S]*?^```)/m);
  return parts
    .map((p, i) =>
      i % 2
        ? p
        : p
            .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/\s*\{#[\w-]+\}/g, "")
            .replace(/<\/?[A-Za-z][^>]*>/g, "")
            .replace(/^import .*$/gm, "")
            .replace(/[ \t]+$/gm, "")
    )
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Licenses the crypto pack takes a BIP under (its "License:" header, SPDX ids or "PD").
const PERMISSIVE = new Set(["BSD-2-Clause", "BSD-3-Clause", "MIT", "CC0-1.0", "PD", "CC-BY-4.0", "FSFAP", "Apache-2.0"]);

/** The BIP's license if it (or one of its "OR" alternatives) is permissive, else null (no header, share-alike, OPL…). */
export function bipLicense(text) {
  const m = text.match(/^\s*License:\s*(.+)$/m);
  if (!m) return null;
  const expr = m[1].trim();
  return expr.split(/\s+OR\s+/).some((l) => PERMISSIVE.has(l.trim())) ? expr : null;
}

/** "BIP-32", "BIP32", "BIP 32" style aliases for a numbered proposal. */
export function numberAliases(prefixes, n) {
  return prefixes.flatMap((p) => [`${p}-${n}`, `${p}${n}`, `${p} ${n}`]);
}

/** An EIP or ERC markdown file → pack document fields (null for stubs that only point elsewhere). */
export function eipDoc(raw, { repo }) {
  const [f, body] = frontMatter(raw);
  const n = Number(f.eip);
  if (!Number.isInteger(n) || !f.title) return null;
  const erc = repo === "ERCs" || f.category === "ERC";
  const kind = erc ? "ERC" : "EIP";
  const title = `${kind}-${n}: ${f.title}`;
  const meta = [f.description, f.status && `Status: ${f.status}`, f.type && `Type: ${f.type}${f.category ? ` (${f.category})` : ""}`, f.created && `Created: ${f.created}`, f.requires && `Requires: ${f.requires}`]
    .filter(Boolean)
    .join("\n");
  const text = `# ${title}\n\n${meta}\n\n${cleanMarkdown(body)}`;
  return {
    number: n,
    title,
    text,
    url: erc ? `https://ercs.ethereum.org/ERCS/erc-${n}` : `https://eips.ethereum.org/EIPS/eip-${n}`,
    aliases: numberAliases(erc ? ["ERC", "EIP"] : ["EIP"], n),
  };
}

/** A BIP (.mediawiki or .md) → pack document fields, or null when it isn't under a permissive license. */
export function bipDoc(raw, { file }) {
  const license = bipLicense(raw);
  const head = raw.match(/^\s*BIP:\s*(\d+)[\s\S]*?^\s*Title:\s*(.+)$/m);
  if (!license || !head) return null;
  const n = Number(head[1]);
  const title = `BIP ${n}: ${head[2].trim()}`;
  // The header block (<pre>…</pre> in mediawiki, front matter in markdown) becomes a few plain lines.
  const status = raw.match(/^\s*Status:\s*(.+)$/m)?.[1].trim();
  const bodyRaw = raw.replace(/<pre>[\s\S]*?<\/pre>/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const body = file.endsWith(".mediawiki") ? cleanWikivoyage(bodyRaw) : cleanMarkdown(bodyRaw);
  return {
    number: n,
    title,
    text: `# ${title}\n\n${status ? `Status: ${status}\n\n` : ""}${body}`,
    license,
    aliases: numberAliases(["BIP"], n),
  };
}

/** LaTeX (the Yellow Paper) → one document per \section: [{title, text}]. Display math is dropped, inline math kept as plain symbols. */
export function latexSections(tex) {
  const doc = tex.replace(/(^|[^\\])%.*$/gm, "$1");
  const out = [];
  const parts = doc.split(/\\section\*?\{([^}]*)\}/);
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i].trim();
    const body = parts[i + 1]
      .split(/\\end\{document\}|\\bibliography/)[0]
      .replace(/\\begin\{(equation|align|eqnarray|figure|table|tabular|algorithmic)\*?\}[\s\S]*?\\end\{\1\*?\}/g, "")
      .replace(/\\\[[\s\S]*?\\\]/g, "")
      .replace(/\\(sub)?subsection\*?\{([^}]*)\}/g, (_, sub, t) => `\n\n${sub ? "####" : "###"} ${t}\n\n`)
      .replace(/\\(label|cite|citep|ref|eqref|footnote)\{[^}]*\}/g, "")
      .replace(/\\(textit|textbf|emph|texttt|mathit|mathbf|mathrm|text)\{([^}]*)\}/g, "$2")
      .replace(/\$([^$]*)\$/g, (_, m) => m.replace(/\\([A-Za-z]+)/g, "$1").replace(/[{}^_]/g, ""))
      .replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?/g, "")
      .replace(/[{}]/g, "")
      .replace(/``|''/g, '"')
      .replace(/~/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (body.length >= 300) out.push({ title, text: `# ${title}\n\n${body}` });
  }
  return out;
}
