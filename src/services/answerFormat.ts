/**
 * Small models asked for bullet points often write them inline on one line:
 * "Takeaway. - Point one. - Point two." Markdown shows that as one paragraph
 * with stray dashes, so this puts each point on its own line. It only acts on
 * two or more " - " after the end of a sentence, so an ordinary dash in a
 * sentence is left alone. Display only, like cleanCitations.
 */
export function splitInlineBullets(text: string): string {
  const inline = /([.!?:])[ \t]+-[ \t]+(?=\S)/g;
  // Numbered steps flattened the same way ("…Hold On: 1. Drop… 2. Cover… 3. Hold On…", a pack's list).
  const numbered = /([.!?:])[ \t]+(\d{1,2})\.[ \t]+(?=\S)/g;
  return text
    .split("\n")
    .map((line) => ((line.match(inline) ?? []).length >= 2 ? line.replace(inline, "$1\n- ") : line))
    .map((line) => ((line.match(numbered) ?? []).length >= 2 ? line.replace(numbered, "$1\n$2. ") : line))
    .join("\n")
    .split("\n")
    // "- 1. Drop… - 2. Cover…" (a numbered list with dashes, Ready.gov): an ordered list, not bullets holding numbers.
    .reduce<string[]>((out, line, i, all) => {
      const numberedBullet = /^- (\d{1,2})\. /;
      const run = numberedBullet.test(line) && (numberedBullet.test(all[i - 1] ?? "") || numberedBullet.test(all[i + 1] ?? ""));
      out.push(run ? line.replace(numberedBullet, "$1. ") : line);
      return out;
    }, [])
    .join("\n");
}
