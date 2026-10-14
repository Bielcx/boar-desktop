/**
 * The "Emergency and preparedness" knowledge pack (scripts/fetch-preparedness.mjs,
 * docs/KNOWLEDGE_PACKS.md): catalog entry and sources for the Knowledge card
 * and the About screen. Values are the measured build v3 of 2026-09-27 (core
 * first-aid articles by name, Portuguese aliases, Wikipedia redirects, Ready.gov
 * numbered steps kept in their section). No native
 * imports.
 */
import type { CatalogModel } from "../models/manifest";
import { registerAssetProvider } from "../models/assetRegistry";

export const PREPAREDNESS_PACK = {
  id: "boar-preparedness",
  name: { en: "Emergency and preparedness", pt: "Emergência e preparação" },
  filename: "corpus/boar-preparedness.sqlite",
  sizeBytes: 16490496,
  sha256: "53d8bcefd8ac65648eb959da2f0761cfb9efcb668822c4030f188312b764865e",
  /** Pinned to the upload commit on the Hugging Face dataset r4topunk/boar-packs. */
  sourceUrl: "https://huggingface.co/datasets/r4topunk/boar-packs/resolve/6e336fe8b7d77af4af081b70b6de15f47647ed36/topics/boar-preparedness.sqlite",
  docCount: 1754,
  builtAt: "2026-09-26",
};

/** Every source in the pack, for attribution (each passage also carries its own page URL and license). */
export const PREPAREDNESS_SOURCES: Array<{ name: string; license: string; url?: string; documents: number }> = [
  { name: "Wikipedia", license: "CC BY-SA 4.0", url: "https://en.wikipedia.org", documents: 902 },
  { name: "Appropedia", license: "CC BY-SA 4.0", url: "https://www.appropedia.org", documents: 567 },
  { name: "Wikibooks (First Aid, Outdoor Survival)", license: "CC BY-SA 4.0", url: "https://en.wikibooks.org", documents: 71 },
  { name: "Wikivoyage", license: "CC BY-SA 4.0", url: "https://en.wikivoyage.org", documents: 8 },
  { name: "Ready.gov and the US National Park Service", license: "Public domain (US government work)", url: "https://www.ready.gov", documents: 182 },
  { name: "US Army Field Manual FM 21-76, Survival (1992)", license: "Public domain (US government work)", url: "https://archive.org/details/USArmyFM2176", documents: 24 },
];

export function preparednessEntry(): CatalogModel {
  return {
    id: PREPAREDNESS_PACK.id,
    kind: "corpus",
    format: "sqlite-pack",
    label: PREPAREDNESS_PACK.name.en,
    filename: PREPAREDNESS_PACK.filename,
    sizeBytes: PREPAREDNESS_PACK.sizeBytes,
    sha256: PREPAREDNESS_PACK.sha256,
    sourceUrl: PREPAREDNESS_PACK.sourceUrl,
    license: "CC BY-SA 4.0 (Wikipedia, Appropedia, Wikibooks, Wikivoyage) and public domain (US government)",
    description: `${PREPAREDNESS_PACK.docCount.toLocaleString("en-US")} articles on first aid, survival, disasters, water, food preservation and self-sufficiency`,
    required: false,
  };
}

registerAssetProvider("preparedness", () => [preparednessEntry()]);
