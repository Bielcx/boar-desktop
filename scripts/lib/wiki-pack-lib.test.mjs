import { describe, it, expect } from "vitest";
import {
  chunkArticle,
  cleanWikivoyage,
  normalizeUrl,
  infoboxText,
  isTable,
  leadChunkIndex,
  leadOf,
  parseDumpPage,
  parseIndexLine,
  parseRedirectRows,
} from "./wiki-pack-lib.mjs";

const ARTICLE = [
  "# Sample",
  "Lead paragraph one. It has two sentences.",
  "Lead paragraph two.",
  "## History",
  "Early history paragraph.",
  "### Later",
  "Later history paragraph.",
  "## Data",
  "| a | b |\n| 1 | 2 |\n| 3 | 4 |",
].join("\n\n");

describe("leadOf", () => {
  it("stops at the first level-2 heading", () => {
    expect(leadOf(ARTICLE)).toBe("# Sample\n\nLead paragraph one. It has two sentences.\n\nLead paragraph two.\n");
  });
  it("caps a long lead at a paragraph boundary", () => {
    const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}\n\n${"c".repeat(30)}`;
    expect(leadOf(text, 70)).toBe(`${"a".repeat(30)}\n\n${"b".repeat(30)}`);
  });
});

describe("chunkArticle", () => {
  it("never crosses a heading and leaves heading lines out", () => {
    const spans = chunkArticle(ARTICLE, 60, 90);
    const pieces = spans.map(([s, e]) => ARTICLE.slice(s, e));
    expect(pieces.some((p) => p.includes("Lead paragraph one") && p.includes("History"))).toBe(false);
    expect(pieces.every((p) => !/^#/.test(p))).toBe(true);
    expect(pieces).toContain("Early history paragraph.");
    expect(pieces).toContain("Later history paragraph.");
  });
  it("packs short paragraphs together up to the target size", () => {
    const [first] = chunkArticle(ARTICLE, 1000, 1500);
    expect(ARTICLE.slice(...first)).toBe("Lead paragraph one. It has two sentences.\n\nLead paragraph two.");
  });
  it("splits an oversized paragraph at sentence ends", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const spans = chunkArticle(long, 200, 300);
    expect(spans.length).toBeGreaterThan(3);
    for (const [s, e] of spans) expect(e - s).toBeLessThanOrEqual(300);
    expect(long.slice(spans[0][0], spans[0][1]).trimEnd().endsWith(".")).toBe(true);
  });
  it("uses UTF-16 offsets, like String.slice in the app", () => {
    const text = "# T\n\nÉmile 🐗 lived here.";
    const [[s, e]] = chunkArticle(text);
    expect(text.slice(s, e)).toBe("Émile 🐗 lived here.");
  });
});

describe("helpers", () => {
  it("detects tables", () => {
    expect(isTable("| a | b |\n| 1 | 2 |")).toBe(true);
    expect(isTable("prose\n| a |\nmore prose")).toBe(false);
  });
  it("flattens infoboxes", () => {
    expect(infoboxText(JSON.stringify([{ data: { Capital: "Canberra", Long: "x".repeat(300) } }]))).toBe("Key facts: Capital: Canberra");
    expect(infoboxText("[]")).toBe("");
    expect(infoboxText("not json")).toBe("");
  });
  it("skips an infobox-only first chunk when picking the lead", () => {
    const text = "Key facts: a: b\n\nThe lead.";
    expect(leadChunkIndex(text, [[0, 15], [17, 26]])).toBe(1);
    expect(leadChunkIndex("The lead.", [[0, 9]])).toBe(0);
  });
});

describe("dump parsing", () => {
  it("reads main-namespace redirect rows", () => {
    const line = "INSERT INTO `redirect` VALUES (10,0,'Computer_accessibility','',''),(12,4,'Wikipedia_page','',''),(13,0,'O\\'Brien_(name)',NULL,NULL);";
    expect(parseRedirectRows(line)).toEqual([
      [10, "Computer accessibility"],
      [13, "O'Brien (name)"],
    ]);
    expect(parseRedirectRows("-- comment")).toEqual([]);
  });
  it("reads index lines with colons in titles", () => {
    expect(parseIndexLine("616:12:Anarchism")).toEqual([12, "Anarchism"]);
    expect(parseIndexLine("616:99:Star Wars: A New Hope")).toEqual([99, "Star Wars: A New Hope"]);
  });
  it("parses a dump page", () => {
    const xml = `<page><title>Rome &amp; around</title><ns>0</ns><id>7</id><revision><id>99</id><text bytes="3">Hi &lt;b&gt;</text></revision></page>`;
    expect(parseDumpPage(xml)).toEqual({ id: 7, ns: "0", title: "Rome & around", redirect: null, text: "Hi <b>" });
    expect(parseDumpPage(`<page><title>A</title><ns>0</ns><id>1</id><redirect title="B" /><text>#REDIRECT</text></page>`).redirect).toBe("B");
  });
});

describe("cleanWikivoyage", () => {
  it("keeps listings as list items and drops other templates, refs and tables", () => {
    const wikitext = [
      "{{pagebanner|Banner.jpg}}",
      "'''Rome''' is the [[Italy|Italian]] capital.<ref>x</ref>",
      "==See==",
      "* {{see| name=Colosseum | address=Piazza del Colosseo | price=€18 | content=The [[amphitheatre]].}}",
      '{| class="wikitable"\n|-\n| a\n|}',
    ].join("\n");
    expect(cleanWikivoyage(wikitext)).toBe(
      "Rome is the Italian capital.\n\n## See\n\n- Colosseum: Piazza del Colosseo. €18. The amphitheatre."
    );
  });

  it("drops image links whose captions span several lines", () => {
    const wikitext = "[[File:Heimlich.jpg|thumb|Abdominal thrusts\n1 - fist above the navel\n2 - pull inward and up]]\nChoking is a blocked airway.";
    expect(cleanWikivoyage(wikitext)).toBe("Choking is a blocked airway.");
  });

  it("drops image links whose captions hold nested links", () => {
    const wikitext = "[[File:Trail.jpg|thumb|A trail in [[Jotunheimen]], [[Norway]]]]\nHiking is walking in [[nature]].";
    expect(cleanWikivoyage(wikitext)).toBe("Hiking is walking in nature.");
  });
});

describe("normalizeUrl", () => {
  it("encodes raw titles and leaves encoded URLs alone", () => {
    expect(normalizeUrl("https://en.wikipedia.org/wiki/Quantum cryptography")).toBe("https://en.wikipedia.org/wiki/Quantum_cryptography");
    expect(normalizeUrl("https://en.wikipedia.org/wiki/Diffie–Hellman key exchange")).toBe("https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange");
    expect(normalizeUrl("https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange")).toBe("https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange");
    expect(normalizeUrl("https://www.ready.gov/some page")).toBe("https://www.ready.gov/some%20page");
  });
});
