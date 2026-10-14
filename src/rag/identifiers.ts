/**
 * Standards named by number (EIP-1559, ERC-20, BIP-32): a question that names one asks about that page, whatever the
 * lexicon finds around it. Pure, so the evals can use it without the app.
 */

const IDENTIFIER = /\b(EIP|ERC|BIP)[-\s]?(\d{1,5})\b/gi;

/** Standards named by number in a question, in their titles' form: "EIP-1559", "ERC-20", "BIP-32". */
export function identifiersIn(query: string): string[] {
  return [...new Set([...query.matchAll(IDENTIFIER)].map((m) => `${m[1].toUpperCase()}-${Number(m[2])}`))];
}

/** Whether a title names that standard: "EIP-1559: Fee market change…", "BIP 32", "ERC20". */
export function titleHasIdentifier(title: string, id: string): boolean {
  const [kind, n] = id.split("-");
  return new RegExp(`\\b${kind}[-\\s]?0*${n}\\b`, "i").test(title);
}
