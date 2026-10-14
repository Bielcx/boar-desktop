/**
 * A model's label without its parenthesized details, for tight spots like the chat header:
 * "Qwen2.5-1.5B-Instruct (Q4_K_M)" -> "Qwen2.5-1.5B-Instruct". The full label stays in Settings.
 */
export function shortModelLabel(label: string): string {
  const short = label.replace(/\s*\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  return short || label.trim();
}
