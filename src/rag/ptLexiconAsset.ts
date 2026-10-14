import type { Lexicon } from "./ptLexicon";

export type LexiconStatus =
  | { state: "not-loaded" }
  | { state: "loaded"; names: number }
  | { state: "failed"; error: string };

let cached: Lexicon | null = null;
let status: LexiconStatus = { state: "not-loaded" };

/**
 * The bundled Portuguese -> English name lexicon (assets/lexicon/pt-en.json), loaded on first use. If the asset is
 * missing from the bundle, Portuguese questions still work (without English names, so worse) and the failure is
 * logged and visible in lexiconStatus() instead of passing silently (it once did, and gates measured Portuguese
 * without the lexicon).
 */
const loadAsset = (): unknown => require("../../assets/lexicon/pt-en.json");

export function ptLexicon(load: () => unknown = loadAsset): Lexicon {
  if (!cached) {
    try {
      const loaded = load() as Lexicon;
      const names = loaded && typeof loaded === "object" ? Object.keys(loaded).length : 0;
      if (!names) throw new Error("the lexicon asset is empty");
      cached = loaded;
      status = { state: "loaded", names };
    } catch (e: any) {
      cached = {};
      status = { state: "failed", error: String(e?.message ?? e) };
      console.error(`[ptLexicon] Portuguese -> English lexicon failed to load: ${status.error}. Portuguese questions will search without English names.`);
    }
  }
  return cached;
}

/** Whether the lexicon loaded, how many names it has, or why it failed (for diagnostics and tests). */
export function lexiconStatus(): LexiconStatus {
  return status;
}
