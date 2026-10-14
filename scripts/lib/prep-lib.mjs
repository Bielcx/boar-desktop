// HTML → markdown-ish text for government guidance pages (no dependencies).

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", deg: "°" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * The page's main content as text: <main> (or <article>, or <body>) without
 * scripts, navigation, headers, footers and forms; h1-h4 become "#" headings,
 * list items "- " lines, paragraphs blank-line separated.
 */
export function htmlToText(html) {
  const title = decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").replace(/\s*\|.*$/, "").trim();
  let main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  main = main
    .replace(/<(script|style|noscript|nav|header|footer|form|aside|svg|button|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, " ")
    // Screen-reader-only labels ("Image" above an illustration) aren't content.
    .replace(/<(div|span|label|p)\b[^>]*class="[^"]*visually-hidden[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const text = main
    // A numbered step written as a heading ("1. Drop (or Lock)", Ready.gov) is a step of the section above, not a
    // section of its own: kept as a list item so the whole procedure stays in one passage.
    .replace(/<h[2-6][^>]*>\s*(\d{1,2})[.)]\s*([\s\S]*?)<\/h[2-6]>\s*/gi, (_, n, t) => `\n- ${n}. ${t.replace(/<[^>]+>/g, "").trim()}: `)
    .replace(/<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${"#".repeat(Number(l))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  // Link lists at the end of guidance pages ("Additional Resources", "Partner Resources") aren't guidance.
  const withoutLinks = text.replace(/\n#{2,4} (Additional|Partner|Related) Resources[\s\S]*$/i, "");
  const clean = decodeEntities(withoutLinks)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^- *$/gm, "")
    .trim();
  return { title, text: clean };
}
