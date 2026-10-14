/**
 * The "Ethereum and cryptography" knowledge pack (scripts/fetch-crypto.mjs,
 * docs/KNOWLEDGE_PACKS.md): catalog entry and sources for the Knowledge card
 * and the About screen. Values are the measured build of 2026-09-26. No native
 * imports.
 */
import type { CatalogModel } from "../models/manifest";
import { registerAssetProvider } from "../models/assetRegistry";

export const CRYPTO_PACK = {
  id: "boar-crypto",
  name: { en: "Ethereum and cryptography", pt: "Ethereum e criptografia" },
  filename: "corpus/boar-crypto.sqlite",
  sizeBytes: 36093952,
  sha256: "ae9fbd2c7a46a46a815d46d0283e7b192adb4c342b38a2adc4881e8f9d8831fb",
  /** Pinned to the upload commit on the Hugging Face dataset r4topunk/boar-packs. */
  sourceUrl: "https://huggingface.co/datasets/r4topunk/boar-packs/resolve/a55c1ec8a5fe8bbda99c4197c33474637bef1958/topics/boar-crypto.sqlite",
  docCount: 3141,
  builtAt: "2026-09-26",
};

/** Every source in the pack, for attribution (each passage also carries its own page URL and license). */
export const CRYPTO_SOURCES: Array<{ name: string; license: string; url?: string; documents: number }> = [
  { name: "Ethereum Improvement Proposals (EIPs)", license: "CC0 1.0", url: "https://eips.ethereum.org", documents: 591 },
  { name: "Ethereum Requests for Comment (ERCs)", license: "CC0 1.0", url: "https://ercs.ethereum.org", documents: 617 },
  { name: "Ethereum consensus, execution, API and Portal Network specifications", license: "CC0 1.0", url: "https://github.com/ethereum/consensus-specs", documents: 129 },
  { name: "Ethereum Yellow Paper", license: "CC BY-SA 4.0", url: "https://github.com/ethereum/yellowpaper", documents: 27 },
  { name: "ethereum.org", license: "MIT", url: "https://ethereum.org", documents: 228 },
  { name: "Bitcoin Improvement Proposals (permissively licensed)", license: "BSD, MIT, CC0, CC BY or public domain (per BIP)", url: "https://github.com/bitcoin/bips", documents: 180 },
  { name: "Wikipedia", license: "CC BY-SA 4.0", url: "https://en.wikipedia.org", documents: 1369 },
];

export function cryptoEntry(): CatalogModel {
  return {
    id: CRYPTO_PACK.id,
    kind: "corpus",
    format: "sqlite-pack",
    label: CRYPTO_PACK.name.en,
    filename: CRYPTO_PACK.filename,
    sizeBytes: CRYPTO_PACK.sizeBytes,
    sha256: CRYPTO_PACK.sha256,
    sourceUrl: CRYPTO_PACK.sourceUrl,
    license: "CC0 1.0 (EIPs, ERCs, specs), CC BY-SA 4.0 (Wikipedia, Yellow Paper), MIT (ethereum.org), per-BIP permissive licenses",
    description: `${CRYPTO_PACK.docCount.toLocaleString("en-US")} documents: Ethereum EIPs, ERCs and specs, ethereum.org, Bitcoin BIPs and Wikipedia on cryptography`,
    required: false,
  };
}

registerAssetProvider("crypto", () => [cryptoEntry()]);
