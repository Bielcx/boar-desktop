/**
 * The one formatter for file and storage sizes, app-wide (Prism N-14; the UI
 * re-exports it from src/ui/flows/format.ts). Pure, no Expo imports.
 *
 * Decimal units, as Android and iOS show sizes (1 MB = 1,000,000 bytes): the
 * same file must read the same size in BOAR, in the system file picker and
 * in Settings. RAM is not formatted here (phones advertise it in binary).
 */

const kB = 1000;
const MB = 1000 * kB;
const GB = 1000 * MB;

function number(value: number, locale: string, digits: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
}

// One decimal below 100, none from 100 up ("18.6 MB", "986 MB", "2.5 GB").
function scaled(bytes: number, unitBytes: number, locale: string): string {
  const v = bytes / unitBytes;
  return number(v, locale, v >= 99.95 ? 0 : 1);
}

/** Number and unit apart, for a big figure with a small unit (`Stat`). */
export function formatBytesParts(bytes: number, locale = "en"): { value: string; unit: string } {
  const b = Math.max(bytes, 0);
  // Switch units where the smaller one would round to 1000 ("1,000 MB" reads as 1 GB).
  if (b >= 999.5 * MB) return { value: scaled(b, GB, locale), unit: "GB" };
  if (b >= 999.5 * kB) return { value: scaled(b, MB, locale), unit: "MB" };
  // A file with any bytes never reads "0 kB".
  return { value: number(b > 0 ? Math.max(1, Math.round(b / kB)) : 0, locale, 0), unit: "kB" };
}

/** "18.6 MB" (en), "18,6 MB" (pt-BR). */
export function formatBytes(bytes: number, locale = "en"): string {
  const { value, unit } = formatBytesParts(bytes, locale);
  return `${value} ${unit}`;
}
