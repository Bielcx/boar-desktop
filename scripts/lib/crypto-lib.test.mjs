import { describe, it, expect } from "vitest";
import { bipDoc, bipLicense, cleanMarkdown, eipDoc, frontMatter, latexSections } from "./crypto-lib.mjs";

describe("frontMatter", () => {
  it("splits simple fields from the body", () => {
    const [f, body] = frontMatter("---\neip: 20\ntitle: Token Standard\n---\n\n## Summary\n");
    expect(f).toEqual({ eip: "20", title: "Token Standard" });
    expect(body).toBe("\n## Summary\n");
  });
});

describe("cleanMarkdown", () => {
  it("keeps link text and code, drops images, tags, anchors and imports", () => {
    const md = 'import X from "y"\n\n## What is it? {#what}\n\nSee [the spec](./spec.md) <Card title="x">now</Card>.\n![img](a.png)\n\n```python\nMAX = 6  # [not](a link)\n```';
    expect(cleanMarkdown(md)).toBe("## What is it?\n\nSee the spec now.\n\n```python\nMAX = 6  # [not](a link)\n```");
  });
});

describe("eipDoc", () => {
  const erc20 = "---\neip: 20\ntitle: Token Standard\nstatus: Final\ntype: Standards Track\ncategory: ERC\ncreated: 2015-11-19\n---\n\n## Simple Summary\n\nA standard interface for tokens.\n";
  it("names ERCs as ERC-N with EIP aliases and the ERC site URL", () => {
    const d = eipDoc(erc20, { repo: "ERCs" });
    expect(d.title).toBe("ERC-20: Token Standard");
    expect(d.url).toBe("https://ercs.ethereum.org/ERCS/erc-20");
    expect(d.aliases).toEqual(expect.arrayContaining(["ERC20", "ERC-20", "EIP-20"]));
    expect(d.text).toContain("Status: Final");
    expect(d.text).toContain("A standard interface for tokens.");
  });
  it("names core EIPs as EIP-N", () => {
    const d = eipDoc("---\neip: 4844\ntitle: Shard Blob Transactions\ncategory: Core\n---\nBody", { repo: "EIPs" });
    expect(d.title).toBe("EIP-4844: Shard Blob Transactions");
    expect(d.aliases).not.toContain("ERC-4844");
  });
  it("skips files without a number or title", () => {
    expect(eipDoc("moved to the ERCs repository", { repo: "EIPs" })).toBeNull();
  });
});

describe("BIPs", () => {
  const bip = (license) => `<pre>\n  BIP: 32\n  Title: Hierarchical Deterministic Wallets\n  Status: Deployed\n${license ? `  License: ${license}\n` : ""}</pre>\n\n==Abstract==\n\nDerive keys from a '''seed'''.\n`;
  it("accepts permissive licenses, including one side of an OR", () => {
    expect(bipLicense(bip("BSD-2-Clause"))).toBe("BSD-2-Clause");
    expect(bipLicense(bip("BSD-2-Clause OR OPUBL-1.0"))).toBe("BSD-2-Clause OR OPUBL-1.0");
    expect(bipLicense(bip("PD"))).toBe("PD");
  });
  it("rejects missing, share-alike and open-publication-only licenses", () => {
    expect(bipLicense(bip(null))).toBeNull();
    expect(bipLicense(bip("CC-BY-SA-4.0"))).toBeNull();
    expect(bipLicense(bip("OPL"))).toBeNull();
  });
  it("turns a BIP into a document with aliases and cleaned wikitext", () => {
    const d = bipDoc(bip("BSD-2-Clause"), { file: "bip-0032.mediawiki" });
    expect(d.title).toBe("BIP 32: Hierarchical Deterministic Wallets");
    expect(d.aliases).toEqual(expect.arrayContaining(["BIP-32", "BIP32", "BIP 32"]));
    expect(d.text).toBe("# BIP 32: Hierarchical Deterministic Wallets\n\nStatus: Deployed\n\n## Abstract\n\nDerive keys from a seed.");
    expect(bipDoc(bip(null), { file: "bip-0032.mediawiki" })).toBeNull();
  });
});

describe("latexSections", () => {
  it("splits on sections, drops display math and keeps inline math as text", () => {
    const filler = "Words about the state machine. ".repeat(12);
    const tex = `\\documentclass{article}\n\\section{Introduction}\\label{sec:intro}\n${filler}\n% a comment\n\\subsection{Driving Factors}\nGas is $\\mathbf{G}_{\\mathrm{base}}$ per tx.\n\\begin{equation}\nx = y\n\\end{equation}\n\\section{Tiny}\nshort\n\\end{document}`;
    const [s, ...rest] = latexSections(tex);
    expect(rest).toEqual([]);
    expect(s.title).toBe("Introduction");
    expect(s.text).toContain("### Driving Factors");
    expect(s.text).toContain("Gas is Gbase per tx.");
    expect(s.text).not.toMatch(/x = y|comment|\\label/);
  });
});
