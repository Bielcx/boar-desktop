/// <reference types="node" />
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompress } from "fzstd";
import { nodeSqliteDatabase } from "./testing/nodeSqlite";
import { WikiPack, isTravelQuestion } from "./wikiPack";
import { readFileSync } from "node:fs";

// The Wikivoyage destination rule (a guide a travel question names goes first) and its limits (Ricardo, #34):
// a capitalized word that happens to be a guide's name, in a question that isn't about travel, never goes first.
// Made-up, test-only documents; guides share the travel words, as real Wikivoyage guides do.
const filler = (topic: string) =>
  Array.from({ length: 6 }, (_, i) => `${topic} filler sentence number ${i} about unrelated matters.`).join(" ");
const guide = (page_id: number, title: string, sections: string[]) => ({
  page_id, title, source: "enwikivoyage",
  text: [`# ${title}`, "", `${title} is a destination. ${filler(title)}`, "", ...sections].join("\n"),
});
const rows = [
  guide(7e9 + 1, "Brazil", ["## Cope", "", "### Electricity", "", "Outlets accept flat and round plugs; the voltage is 127 V or 220 V depending on the state. " + filler("Power")]),
  // Distractors that repeat the question's words more than Brazil's own section does.
  ...["Australia", "Israel", "Philippines"].map((t, i) =>
    guide(7e9 + 10 + i, t, ["## Understand", "", "### Power", "", `${"The plug type and the mains voltage: plug adapters and voltage converters. ".repeat(3)}` + filler(t)])
  ),
  guide(7e9 + 20, "Como", ["## Understand", "", "Como is a lakeside city in Lombardy. " + filler("Lake")]),
  guide(7e9 + 21, "Darwin", ["## Understand", "", "Darwin is the capital of the Northern Territory, named after Charles Darwin. " + filler("Top End")]),
  guide(7e9 + 22, "Rome", ["## Understand", "", "Rome was the capital of an empire that fell in the fifth century. " + filler("Forum")]),
  guide(7e9 + 23, "Rust", ["## Understand", "", "Rust is a small town in Burgenland, Austria, known for storks and wine. " + filler("Stork")]),
  {
    page_id: 904, title: "Fall of the Western Roman Empire", source: "enwiki",
    text: `# Fall of the Western Roman Empire\n\nThe Western Roman Empire fell in 476 when Romulus Augustulus was deposed. ${filler("Empire")}`,
  },
  {
    page_id: 905, title: "Rust (programming language)", source: "enwiki",
    text: `# Rust (programming language)\n\nRust is a programming language; learning Rust means learning ownership, borrowing and sockets. ${filler("Borrow")}`,
  },
  {
    page_id: 900, title: "Burn", source: "enwiki", aliases: ["Queimadura", "Queimaduras"],
    text: `# Burn\n\nA burn is an injury to skin caused by heat. Cool the burn with running water for twenty minutes. ${filler("Burn")}`,
  },
  {
    page_id: 901, title: "Charles Darwin", source: "enwiki",
    text: `# Charles Darwin\n\nCharles Darwin was a naturalist who published On the Origin of Species in 1859. ${filler("Naturalist")}`,
  },
  {
    page_id: 902, title: "Plate tectonics", source: "enwiki",
    text: `# Plate tectonics\n\nMost earthquakes happen at plate boundaries, where plates collide. ${filler("Plates")}`,
  },
  {
    page_id: 903, title: "Photosynthesis", source: "enwiki",
    text: `# Photosynthesis\n\nPlants turn light, water and carbon dioxide into sugar and oxygen. ${filler("Leaf")}`,
  },
];

let pack: WikiPack;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "boar-pack-dest-"));
  const shard = join(dir, "dest.jsonl");
  writeFileSync(shard, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = join(dir, "dest.sqlite");
  execFileSync(process.execPath, ["scripts/build-wiki-pack.mjs", "--out", out, "--shards", shard, "--no-embed"], { stdio: "pipe" });
  pack = await WikiPack.open(nodeSqliteDatabase(out), decompress);
}, 60000);

const first = async (q: string) => (await pack.search(q))[0];

describe("Wikivoyage destination rule", () => {
  it("a practical travel question goes to the guide it names, not to guides repeating its words", async () => {
    const hit = await first("What plug type and voltage does Brazil use?");
    expect(hit?.title).toBe("Brazil");
  });

  it("a sentence-initial question word that is also a guide's name (PT 'Como') is not a destination", async () => {
    const hit = await first("Como tratar uma queimadura?");
    expect(hit?.title).toBe("Burn");
  });

  it("a person's name in a non-travel question doesn't bring the guide named after them", async () => {
    // "Darwin" alone resolves only to the Wikivoyage guide (the encyclopedia article is "Charles Darwin").
    const hits = await pack.search("When did Darwin publish On the Origin of Species?");
    expect(hits[0]?.title).toBe("Charles Darwin");
    expect(hits.some((h) => h.title === "Darwin")).toBe(false);
  });

  it("health and science questions never put a Wikivoyage guide first", async () => {
    for (const q of ["How do I treat a burn?", "Why do earthquakes happen at plate boundaries?", "How does photosynthesis work?", "When did Darwin publish his theory?"]) {
      const hit = await first(q);
      expect(hit?.source, q).not.toBe("enwikivoyage");
    }
  });

  it("every v2 travel question is a travel question; a generic word (época, tips, season, cash, thank you) doesn't make one", () => {
    const travel = readFileSync("eval/retrieval/questions.travel.v2.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).query as string);
    expect(travel).toHaveLength(16);
    for (const q of travel) expect(isTravelQuestion(q), q).toBe(true);
    for (const q of [
      "Em que época Roma caiu?",
      "Tips for learning Rust",
      "What is the best time complexity of sorting in Rust?",
      "How do Rust sockets work?",
      "Which season does Game of Thrones end?",
      "Is cash king in Bitcoin?",
      "How do I say thank you to a colleague?",
      "Tenho visto Roma no mapa, onde fica?",
    ]) expect(isTravelQuestion(q), q).toBe(false);
  });

  it("so those questions don't put the guide they happen to name first", async () => {
    for (const q of ["Tips for learning Rust", "How do Rust sockets work?"]) {
      const hit = await first(q);
      expect(hit?.source, q).not.toBe("enwikivoyage");
    }
  });

  it("the opening question word is never taken for a name, in a travel question too", async () => {
    const como = await pack.resolveTitle("Como", { fuzzy: false, source: "enwikivoyage" });
    for (const q of ["Como funciona a fotossíntese?", "Como tratar uma queimadura?", "Como pagar com cartão em Lisboa?"]) {
      const named = await pack.titlesInQuestion(q, await pack.stems(q));
      expect(named.map((n) => n.id), q).not.toContain(como);
    }
  });
});

// Self-review of #34 (PR34-1, PR34-2), on a Wikivoyage-only pack like the shipped one (no encyclopedia articles).
describe("Wikivoyage destination rule on a Wikivoyage-only pack", () => {
  const voyage = [
    guide(8e9 + 1, "Darwin", ["## Understand", "", "Darwin is the capital of the Northern Territory. " + filler("Top End")]),
    guide(8e9 + 2, "New York City", ["## Get around", "", "### By taxi", "", "Yellow cabs can be hailed on the street. " + filler("Cab")]),
    guide(8e9 + 3, "Brazil", ["## Buy", "", "### Money", "", "The currency is the real. " + filler("Money"), "", "## Cope", "", "### Electricity", "", "Outlets take flat and round plugs; voltage is 127 V or 220 V. " + filler("Power")]),
    guide(8e9 + 4, "Jordan", ["## Understand", "", "Jordan is a kingdom in the Middle East. " + filler("Petra")]),
    guide(8e9 + 5, "Argentina", ["## Get in", "", "Most visitors need no visa for short stays. " + filler("Border")]),
    guide(8e9 + 6, "Natal", ["## Understand", "", "Natal is a city on the coast of Rio Grande do Norte. " + filler("Dunes")]),
    { ...guide(8e9 + 7, "Georgia (disambiguation)", ["There is more than one place called Georgia: the country, and the US state."]), aliases: ["Georgia"] },
    guide(8e9 + 9, "Japan", ["## Get in", "", "Visitors from many countries need no visa for short stays. " + filler("Visa")]),
    guide(8e9 + 10, "United States", ["## Get in", "", "The visa waiver program covers many nationalities. " + filler("Border")]),
    guide(8e9 + 11, "New Zealand", ["## Get in", "", "Most visitors need an electronic travel authority. " + filler("Kiwi")]),
    guide(8e9 + 12, "Kyoto", ["## Get in", "", "The shinkansen from Tokyo Station takes about two hours. " + filler("Temple")]),
    { ...guide(8e9 + 13, "Tokyo/Chiyoda", ["## Get in", "", "Tokyo Station is the main rail hub. " + filler("Rail")]), aliases: ["Tokyo Station"] },
    guide(8e9 + 14, "Victoria", ["## Understand", "", "Victoria is a state in the south-east of Australia. " + filler("Melbourne")]),
    guide(8e9 + 15, "Victoria (British Columbia)", ["## Sleep", "", "Tourists stay downtown near the Inner Harbour. " + filler("Harbour")]),
    guide(8e9 + 16, "British Columbia", ["## Sleep", "", "Tourists stay in many places across the province. " + filler("Province")]),
    guide(8e9 + 8, "Georgia (country)", ["## Stay healthy", "", "Tap water is safe to drink in most cities. " + filler("Water"), "", "## Get in", "", "Many nationalities need no visa. " + filler("Visa")]),
  ];
  let vp: WikiPack;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "boar-pack-voyage-"));
    const shard = join(dir, "voyage.jsonl");
    writeFileSync(shard, voyage.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out = join(dir, "voyage.sqlite");
    execFileSync(process.execPath, ["scripts/build-wiki-pack.mjs", "--out", out, "--shards", shard, "--no-embed"], { stdio: "pipe" });
    vp = await WikiPack.open(nodeSqliteDatabase(out), decompress);
  }, 60000);
  const shareOf = async (q: string, title: string) => {
    const id = await vp.resolveTitle(title, { fuzzy: false, source: "enwikivoyage" });
    return (await vp.titlesInQuestion(q, await vp.stems(q))).find((n) => n.id === id)?.share ?? 0;
  };

  it("a name in a biography or history question is not a destination, even with a travel-looking word", async () => {
    // A destination gets share 1 (goes first); these may still be found by the ordinary share rule, never as destinations.
    expect(await shareOf("Where did Charles Darwin travel on the Beagle?", "Darwin")).toBeLessThan(1);
    expect(await shareOf("Why are New York taxis yellow?", "New York City")).toBeLessThan(1);
    expect(await shareOf("When did Brazil change its currency to the real?", "Brazil")).toBeLessThan(1);
    expect(await shareOf("How long can Jordan stay in the air when he dunks?", "Jordan")).toBeLessThan(1);
  });

  it("only the first destination of a travel question counts (PT 'Argentina no Natal': Natal is Christmas)", async () => {
    const q = "Preciso de visto para visitar a Argentina no Natal?";
    expect(await shareOf(q, "Argentina")).toBe(1);
    expect(await shareOf(q, "Natal")).toBeLessThan(1);
  });

  it("in a two-place question the destination goes first, not the origin or the region (self-review of dbf0cd5)", async () => {
    const cases: Array<[string, string, string]> = [
      ["Do I need a visa for Japan if I live in the United States?", "Japan", "United States"],
      ["Do I need a visa for Japan as a citizen of New Zealand?", "Japan", "New Zealand"],
      ["How do I get to Kyoto from Tokyo Station?", "Kyoto", "Tokyo/Chiyoda"],
      ["Where do tourists stay in Victoria, British Columbia?", "Victoria (British Columbia)", "British Columbia"],
    ];
    for (const [q, dest, other] of cases) {
      expect(await shareOf(q, dest), q).toBe(1);
      expect(await shareOf(q, other), q).toBeLessThan(1);
      expect((await vp.search(q))[0]?.title, q).toBe(dest);
    }
  });

  it("a bare name that redirects to a disambiguation page is never put first", async () => {
    const dis = await vp.resolveTitle("Georgia (disambiguation)", { fuzzy: false, source: "enwikivoyage" });
    for (const q of ["Is tap water safe to drink in Georgia?", "Do I need a visa for Georgia?"]) {
      const named = await vp.titlesInQuestion(q, await vp.stems(q));
      expect(named.map((n) => n.id), q).not.toContain(dis);
      const hits = await vp.search(q);
      expect(hits[0]?.title, q).not.toBe("Georgia (disambiguation)");
    }
  });

  it("a practical travel question still goes to the guide it names", async () => {
    expect(await shareOf("What plug type and voltage does Brazil use?", "Brazil")).toBe(1);
    expect((await vp.search("What plug type and voltage does Brazil use?"))[0]?.title).toBe("Brazil");
  });
});
