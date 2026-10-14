/// <reference types="node" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompress } from "fzstd";
import { nodeSqliteDatabase } from "./testing/nodeSqlite";
import { ACTION_INTENT, WikiPack, countAtBoundary, coverage, instructionShare, nearDuplicate, sectionAt, sectionKind, stepsFirst, titleCandidates } from "./wikiPack";

// A pack built by the real builder from a fixture of six made-up, test-only
// articles (src/rag/testing/fixtures/mini-wiki.jsonl), read back with fzstd,
// the decompressor the app uses.
let pack: WikiPack;

beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "boar-pack-")), "mini.sqlite");
  execFileSync(process.execPath, [
    "scripts/build-wiki-pack.mjs", "--out", out, "--shards", "src/rag/testing/fixtures/mini-wiki.jsonl", "--no-embed", "--chunk-chars", "300",
  ], { stdio: "pipe" });
  pack = await WikiPack.open(nodeSqliteDatabase(out), decompress);
}, 60000);

describe("pure helpers", () => {
  it("flags a paragraph copied between articles as a near duplicate, not two passages on one topic", () => {
    const nsa = "In August 2015, NSA announced that it is planning to transition in the not distant future to a new cipher suite that is resistant to quantum attacks.";
    const suiteB = "In August 2015, NSA announced that it is planning to transition in the not too distant future to a new cipher suite that is resistant to quantum attacks.";
    expect(nearDuplicate(nsa, suiteB)).toBe(true);
    expect(nearDuplicate(nsa, "Post-quantum cryptography develops algorithms thought to be secure against an attack by a quantum computer.")).toBe(false);
  });

  it("finds the heading path at an offset", () => {
    const text = "# T\n\nlead\n\n## A\n\na\n\n### B\n\nb\n\n## C\n\nc";
    expect(sectionAt(text, text.indexOf("lead"))).toBe("");
    expect(sectionAt(text, text.indexOf("\nb") + 1)).toBe("A > B");
    expect(sectionAt(text, text.lastIndexOf("c"))).toBe("C");
  });
  it("counts stem prefixes at word boundaries only", () => {
    expect(countAtBoundary("hole", "black holes and wholesome holes")).toBe(2);
    expect(coverage("Black holes bend light", [{ stem: "hole", idf: 3 }, { stem: "galaxi", idf: 1 }])).toBe(0.75);
  });
  it("proposes title n-grams without edge stopwords, longest first", () => {
    const c = titleCandidates("Compare the French Revolution and the Industrial Revolution");
    expect(c.indexOf("French Revolution")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("Industrial Revolution")).toBeGreaterThanOrEqual(0);
    expect(c.every((t) => !/^(the|and) /i.test(t))).toBe(true);
    expect(c.indexOf("French Revolution")).toBeLessThan(c.indexOf("French"));
  });
});

describe("WikiPack", () => {
  it("reads articles back from the compressed blocks", async () => {
    const id = await pack.resolveTitle("black hole");
    const a = await pack.article(id!);
    expect(a.title).toBe("Black hole");
    expect(a.text.startsWith("# Black hole\n\nA black hole is a region")).toBe(true);
  });

  it("puts the article the question is about first (title boost), not a keyword neighbour", async () => {
    // "black hole" carries most of the question: its lead goes first as a named article.
    expect((await pack.search("What is a black hole?"))[0]).toMatchObject({ title: "Black hole", via: "title", lead: true });
    // Here "form" is rarer than the name, so the name is a partial subject: BM25 decides, and still picks the right article.
    const hits = await pack.search("What is a black hole and how does one form?");
    expect(hits[0].title).toBe("Black hole");
    expect(hits.some((h) => h.title === "Black hole" && h.section === "Formation")).toBe(true);
    expect(hits.findIndex((h) => h.title === "Black Sea")).not.toBe(0);
  });

  it("doesn't put a side mention first", async () => {
    // "Black Sea" is named, but the question is about the countries' economy: it carries under half of the weight.
    const named = await pack.titlesInQuestion("Which financial crisis and debt problems led to the revolution, not the Black Sea trade?", await pack.stems("Which financial crisis and debt problems led to the revolution, not the Black Sea trade?"));
    expect(named.every((n) => n.share < 0.5)).toBe(true);
  });

  it("covers both sides of a comparison", async () => {
    const hits = await pack.search("Compare the French Revolution and the Industrial Revolution.", { k: 4 });
    expect(hits.slice(0, 4).map((h) => h.title).sort()).toEqual(["French Revolution", "French Revolution", "Industrial Revolution", "Industrial Revolution"]);
  });

  it("resolves plural question words to the singular title", async () => {
    const hits = await pack.search("How do vaccines train the immune system?");
    expect(hits[0].title).toBe("Vaccine");
  });

  it("reports popularity so callers can go sources-first on the long tail", async () => {
    const hits = await pack.search("Why was Kuala Kubu Bharu rebuilt?");
    expect(hits[0]).toMatchObject({ title: "Kuala Kubu Bharu", views: 900 });
  });

  it("asks the expansion callback only when the keyword search comes back thin", async () => {
    const expand = vi.fn(async () => ["Black hole"]);
    await pack.search("What is a black hole?", { expand });
    expect(expand).not.toHaveBeenCalled();
    const hits = await pack.search("Where do photons stay stuck eternally?", { expand, minHits: 1 });
    expect(expand).toHaveBeenCalledTimes(1);
    expect(hits.some((h) => h.title === "Black hole")).toBe(true);
  });

  it("resolves multi-word titles fuzzily but never single words", async () => {
    expect(await pack.resolveTitle("Kuala Kubu")).not.toBeNull();
    expect(await pack.resolveTitle("Kuala")).toBeNull();
  });
});

describe("matchTerm", () => {
  it("matches porter's y→i stems as a prefix, everything else exactly", async () => {
    const { matchTerm } = await import("./wikiPack");
    expect(matchTerm("purifi")).toBe('"purif"*');
    expect(matchTerm("water")).toBe('"water"');
    expect(matchTerm("hi")).toBe('"hi"');
  });
});

describe("sectionKind", () => {
  it("lets the last heading decide, and tells a what-to-do heading from one that only sits under one", () => {
    expect(sectionKind("Treatment")).toBe("action");
    expect(sectionKind("Management > Intravenous fluids")).toBe("action-sub");
    expect(sectionKind("Management > Forecasting")).toBe("background");
    expect(sectionKind("Prevention")).toBe("background");
    expect(sectionKind("Effects > Fires")).toBe("other");
    expect(sectionKind("During an earthquake")).toBe("action");
  });
});

describe("instructionShare", () => {
  it("scores steps above context", () => {
    const steps = 'Stay indoors. Get down on the floor and cover your head. Hold on to the table. Do not run outside.';
    const context = "Earthquakes are unpredictable. An early warning system gives people a few seconds. Such systems exist in Japan.";
    expect(instructionShare(steps)).toBeGreaterThan(0.7);
    expect(instructionShare(context)).toBe(0);
    expect(instructionShare("If you are in bed, stay there and cover your head.")).toBe(1);
  });
});

describe("stepsFirst", () => {
  const order = (items: Array<[string, number]>) => stepsFirst(items.map(([sec, s]) => ({ sec, s })), (x) => x.sec).map((x) => x.sec);
  it("keeps the best section's own subsections together, a section before its subsections", () => {
    expect(order([["After", 0.9], ["During > If you are indoors", 0.8], ["During", 0.95], ["After > Get out", 0.85]])).toEqual([
      "During", "During > If you are indoors", "After", "After > Get out",
    ]);
    expect(order([["Treatment > Nasal packing", 0.9], ["Treatment", 0.7]])).toEqual(["Treatment", "Treatment > Nasal packing"]);
  });
  it("doesn't let shallow unrelated subsections jump ahead of the best one", () => {
    expect(order([["Trip > Swimming", 0.6], ["Trip > Disease > Water contamination", 0.9], ["Trip > Animals", 0.5]])[0]).toBe(
      "Trip > Disease > Water contamination"
    );
  });
});

describe("ACTION_INTENT", () => {
  it("reads what-to-do questions, including canonical search terms ending in the action", () => {
    for (const q of ["What should I do?", "How do I stop a nosebleed?", "O que eu faço?", "Como tratar uma queimadura?", "nosebleed nose bleed stop", "snakebite what to do"]) expect(ACTION_INTENT.test(q), q).toBe(true);
    for (const q of ["Why do we have seasons?", "When did the war stop in 1945?", "What is Ethereum?"]) expect(ACTION_INTENT.test(q), q).toBe(false);
  });
});

