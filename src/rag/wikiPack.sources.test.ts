/// <reference types="node" />
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompress } from "fzstd";
import { nodeSqliteDatabase } from "./testing/nodeSqlite";
import { WikiPack } from "./wikiPack";

// Topic-pack sources beyond Wikipedia (the crypto pack's EIPs, specs, BIPs):
// source codes survive the round trip and "aliases" resolve like redirects.
// Made-up, test-only documents.
const filler = (topic: string) =>
  Array.from({ length: 6 }, (_, i) => `${topic} filler sentence number ${i} about unrelated matters.`).join(" ");
const rows = [
  {
    page_id: 5e9 + 20, title: "ERC-20: Token Standard", source: "eips", url: "https://eips.ethereum.org/EIPS/eip-20", license: "CC0-1.0",
    aliases: ["ERC-20", "ERC20", "EIP-20"],
    text: `# ERC-20: Token Standard\n\nA standard interface for fungible tokens with transfer and approve functions. ${filler("Token")}`,
  },
  {
    page_id: 8e9 + 32, title: "BIP 32: Hierarchical Deterministic Wallets", source: "bips", url: "https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki", license: "BSD-2-Clause",
    aliases: ["BIP-32", "BIP32"],
    text: `# BIP 32: Hierarchical Deterministic Wallets\n\nDescribes deriving a tree of keypairs from a single seed. ${filler("Wallet")}`,
  },
  // Neighbours that mention ERC-20, approve and transfer more often than the standard itself (as vault ERCs do).
  ...[4626, 7535, 5143, 7575].map((n) => ({
    page_id: 5e9 + n, title: `ERC-${n}: Vault extension ${n}`, source: "eips", url: `https://ercs.ethereum.org/ERCS/erc-${n}`, license: "CC0-1.0",
    text: `# ERC-${n}: Vault extension ${n}\n\n${"Vaults hold ERC-20 tokens; users approve the vault, which calls transfer and transferFrom on the ERC-20 token. ".repeat(4)}`,
  })),
  // A first-aid article with Portuguese aliases, and an indexed Portuguese page (as Appropedia has) that puts
  // "como", "uma", "de" and a rare verb in the index.
  {
    page_id: 900, title: "Burn", source: "enwiki", aliases: ["Queimadura", "Queimaduras"],
    text: `# Burn\n\nA burn is an injury to skin caused by heat. Cool the burn with running water for twenty minutes. ${filler("Burn")}`,
  },
  {
    page_id: 3e9 + 7, title: "Horta comunitária", source: "appropedia", url: "https://www.appropedia.org/Horta", license: "CC BY-SA 4.0",
    text: `# Horta comunitária\n\nComo plantar uma horta de verduras e parar de comprar. Como regar uma horta de manhã. ${filler("Horta")}`,
  },
  // A first-aid article whose prevention section repeats the question's words more than its treatment section.
  {
    page_id: 901, title: "Scald", source: "enwiki",
    text: [
      "# Scald", "", "A scald is a burn from hot liquid such as boiling water. " + filler("Scald"), "",
      "## Prevention", "", "To prevent a scald from boiling water, keep children away from boiling water and turn pot handles inward. Boiling water spills cause most child scalds. " + filler("Prevention"), "",
      "## Treatment", "", "Cool the scald under cool running water for twenty minutes, remove tight clothing, and cover it loosely. " + filler("Cooling"), "",
      "## History", "", "Scalds from boiling water were described in ancient medicine. " + filler("History"),
    ].join("\n"),
  },
  // An article whose lead only defines the subject; the section with the question's other words explains it.
  {
    page_id: 902, title: "Plate tectonics", source: "enwiki",
    text: [
      "# Plate tectonics", "", "Plate tectonics is the scientific theory that the lithosphere comprises large tectonic plates. " + filler("Theory"), "",
      "## Plate boundaries", "", "Most earthquakes happen at plate boundaries, where plates collide, separate or slide past each other. " + filler("Boundary"),
    ].join("\n"),
  },
  // Official guidance on the same topic, whose words the question repeats less than the encyclopedia's.
  {
    page_id: 4e9 + 1, title: "Burns and scalds (Ready.gov)", source: "usgov", url: "https://www.ready.gov/burns", license: "Public domain",
    text: [
      "# Burns and scalds (Ready.gov)", "", "Guidance for families. " + filler("Guide"), "",
      "## Treat a burn", "", "Cool the burn under cool running water. Remove rings and tight clothing. Cover it with a clean cloth. Do not use ice. " + filler("Care"),
    ].join("\n"),
  },
];

let pack: WikiPack;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "boar-pack-src-"));
  const shard = join(dir, "crypto.jsonl");
  writeFileSync(shard, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = join(dir, "crypto.sqlite");
  execFileSync(process.execPath, ["scripts/build-wiki-pack.mjs", "--out", out, "--shards", shard, "--no-embed"], { stdio: "pipe" });
  pack = await WikiPack.open(nodeSqliteDatabase(out), decompress);
}, 60000);

describe("topic-pack sources", () => {
  it("resolves aliases to their document, case-insensitively", async () => {
    const eips = { source: "eips" } as const;
    const erc20 = await pack.resolveTitle("ERC-20: Token Standard", eips);
    expect(erc20).not.toBeNull();
    expect(await pack.resolveTitle("erc20", eips)).toBe(erc20);
    expect(await pack.resolveTitle("EIP-20", eips)).toBe(erc20);
    const bips = { source: "bips" } as const;
    expect(await pack.resolveTitle("BIP32", bips)).toBe(await pack.resolveTitle("BIP 32: Hierarchical Deterministic Wallets", bips));
  });

  it("keeps each document's source, URL and license", async () => {
    const a = await pack.article((await pack.resolveTitle("BIP-32", { source: "bips" }))!);
    expect(a.source).toBe("bips");
    expect(a.url).toBe("https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki");
    expect(a.license).toBe("BSD-2-Clause");
  });

  it("puts a primary source a question names first, even when neighbours match more of its words", async () => {
    const hits = await pack.search("How do vaults approve and transferFrom ERC-20 tokens?");
    expect(hits[0]?.title).toBe("ERC-20: Token Standard");
  });

  it("puts the document a question names by its alias first", async () => {
    const hits = await pack.search("What is ERC20?");
    expect(hits[0]?.title).toBe("ERC-20: Token Standard");
  });

  it("finds an article by its Portuguese alias in a Portuguese question", async () => {
    for (const q of ["O que fazer em caso de queimadura?", "Como tratar uma queimadura?", "Como parar de sentir a queimadura?"]) {
      const hits = await pack.search(q);
      expect(hits[0]?.title, q).toBe("Burn");
    }
  });

  it("gives a what-to-do question the article's treatment section, not its prevention or history", async () => {
    const hits = await pack.search("My child spilled boiling water. What do I do about the scald?", { titles: ["Scald"] });
    const sections = hits.filter((h) => h.title === "Scald" && !h.lead);
    expect(sections[0]?.section).toBe("Treatment");
    expect(sections[0]?.action).toBe(true);
    // A question that isn't asking what to do keeps the plain word-overlap order.
    const plain = await pack.search("Why do boiling water spills scald children?", { titles: ["Scald"] });
    expect(plain.filter((h) => h.title === "Scald" && !h.lead)[0]?.section).toBe("Prevention");
  });

  // Behavior guard; this small index can't reproduce the ranking competition, so the rule itself was measured on the
  // real preparedness pack (Ready.gov 'Protect Yourself During Earthquakes': 8th -> 2nd/3rd, EN and PT).
  it("puts official what-to-do guidance among the first passages of a what-to-do question", async () => {
    // Tusk's canonical form of a first-aid question.
    const hits = await pack.search("burn scald what to do", { k: 3 });
    const official = hits.findIndex((h) => h.source === "usgov" && h.action);
    expect(official).toBeGreaterThanOrEqual(0);
    expect(official).toBeLessThan(3);
  });

  it("doesn't let the words that ask for steps ('stop', 'treat') take the subject away from a named article", async () => {
    const q = "Scald stop treat help";
    const named = await pack.titlesInQuestion(q, await pack.stems(q));
    const scald = await pack.resolveTitle("Scald");
    expect(named.find((t) => t.id === scald)?.share ?? 0).toBeGreaterThanOrEqual(0.5);
  });

  it("answers a why question with the section that explains, ahead of the lead that only defines (EN and PT)", async () => {
    const en = await pack.search("Why do earthquakes happen near plate boundaries?", { k: 4, titles: ["Plate tectonics"] });
    expect(en.filter((h) => h.title === "Plate tectonics")[0]?.section).toBe("Plate boundaries");
    // A Portuguese question runs as its English names, with the why intent passed along (retrieve()).
    const pt = await pack.search("Earthquake Plate tectonics", { k: 4, titles: ["Plate tectonics"], explain: true });
    expect(pt.filter((h) => h.title === "Plate tectonics")[0]?.section).toBe("Plate boundaries");
    // Not a why question: the lead stays first.
    const what = await pack.search("What is plate tectonics?", { k: 4, titles: ["Plate tectonics"] });
    expect(what.filter((h) => h.title === "Plate tectonics")[0]?.section).toBe("");
  });
});
