/**
 * Brand type: Baloo 2 for titles, buttons and big numbers; Lexend for everything read. Both SIL Open
 * Font License 1.1, bundled from the @expo-google-fonts packages (no network). The same faces as the
 * marketing posts.
 *
 * Android doesn't synthesize weights for a custom font, so each weight is its own family and the app's
 * Text (components/AppText.tsx) turns a style's fontWeight into the family here, never passing
 * fontWeight on. Pure, so it's tested without React Native.
 */

/** Every family we bundle; theme/fontFiles.ts provides a file for each. */
export const BUNDLED_FAMILIES = [
  "Baloo2_700Bold",
  "Baloo2_800ExtraBold",
  "Lexend_400Regular",
  "Lexend_500Medium",
  "Lexend_600SemiBold",
  "Lexend_700Bold",
] as const;
export type BundledFamily = (typeof BUNDLED_FAMILIES)[number];

/** Put on a style to ask for the display face (titles); the weight still picks the file. */
export const DISPLAY = "display";
/** Put on a style for code (code blocks, inline code): the one place that stays monospace. */
export const CODE = "code";
/** Old monospace families: everything that isn't code reads in Lexend now, with fixed-width digits. */
const MONO = new Set(["monospace", "Menlo", "Courier", "courier"]);

const weightOf = (w: unknown): number => {
  if (typeof w === "number") return w;
  if (w === "bold") return 700;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : 400;
};

/**
 * The bundled family for a style. Weight 800 and up is display (Baloo 2), as are styles marked
 * DISPLAY; everything else is Lexend at the nearest weight. A family we don't bundle (an icon font)
 * is left as it is, and so is CODE (the app's Text picks the platform's monospace).
 */
export function familyFor(fontFamily: string | undefined, fontWeight: unknown): { family: string; tabular: boolean } {
  const w = weightOf(fontWeight);
  const mono = fontFamily !== undefined && MONO.has(fontFamily);
  if (fontFamily !== undefined && fontFamily !== DISPLAY && !mono && !fontFamily.startsWith("System") && fontFamily !== "sans-serif") {
    return { family: fontFamily, tabular: false };
  }
  if (fontFamily === DISPLAY || w >= 800) return { family: w >= 800 ? "Baloo2_800ExtraBold" : "Baloo2_700Bold", tabular: false };
  const family = w >= 700 ? "Lexend_700Bold" : w >= 600 ? "Lexend_600SemiBold" : w >= 500 ? "Lexend_500Medium" : "Lexend_400Regular";
  return { family, tabular: mono };
}

/**
 * Bigger, easier text (the new UI's scale: body 16, nothing under 12). The old screens set 8-15 in
 * many places; titles (16 and up) keep their size.
 */
export function scaledSize(size: number): number {
  if (size <= 11) return 12;
  if (size === 12) return 13;
  if (size === 13) return 14;
  if (size <= 15) return 16;
  return size;
}

/** A line height grown with its text, so a bigger size never clips. */
export function scaledLineHeight(lineHeight: number, from: number, to: number): number {
  return from > 0 ? Math.round((lineHeight * to) / from) : lineHeight;
}

/** The Settings text size (Compact / Standard / Large) as a multiplier on every font size. */
export function fontScaleFactor(scale: string | undefined): number {
  return scale === "compact" ? 0.9 : scale === "large" ? 1.2 : 1;
}
