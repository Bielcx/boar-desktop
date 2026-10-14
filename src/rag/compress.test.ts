import { describe, it, expect } from "vitest";
import type { RetrievedChunk } from "./retrieve.types";
import { approxTokens, compressContext, compressForAnswer, FAST_CONTEXT_TOKENS, mergeSources, scoreSentences, splitSentences } from "./compress";
import PQ_FIXTURE from "./testing/pq-chunks.json";

const chunk = (chunkId: string, title: string, body: string, score = 1): RetrievedChunk => ({
  chunkId,
  docId: chunkId,
  title,
  body,
  score,
  matchType: "hybrid",
});

// Realistic-length encyclopedia leads (~500 tokens total), same shape the corpus returns.
const CANBERRA = chunk(
  "c1",
  "Canberra",
  "Canberra is the capital city of Australia. Founded following the federation of the colonies of Australia as the seat of government for the new nation, it is Australia's largest inland city. " +
    "The city is located at the northern end of the Australian Capital Territory, 280 km south-west of Sydney and 660 km north-east of Melbourne. " +
    "A resident of Canberra is known as a Canberran. Although Canberra is the capital and seat of government, many federal government ministries have secondary seats in state capital cities. " +
    "The site of Canberra was selected for the location of the nation's capital in 1908 as a compromise between Sydney and Melbourne, the two largest cities. " +
    "The city was designed by the American architects Walter Burley Griffin and Marion Mahony Griffin after an international design contest."
);
const SYDNEY = chunk(
  "c2",
  "Sydney",
  "Sydney is the capital city of the state of New South Wales and the most populous city in Australia. " +
    "Located on Australia's east coast, the metropolis surrounds Port Jackson and extends about 80 km on its periphery towards the Blue Mountains to the west. " +
    "Sydney is made up of 658 suburbs, spread across 33 local government areas. " +
    "The city is home to the Sydney Opera House and the Sydney Harbour Bridge, which are among the most recognisable structures in the world."
);
const MOLD = chunk(
  "c3",
  "Mold",
  "A mold or mould is one of the structures that certain fungi can form. The dust-like, colored appearance of molds is due to the formation of spores. " +
    "Molds are considered to be microbes and do not form a specific taxonomic or phylogenetic grouping. " +
    "Mold growth needs moisture, and it can be found both indoors and outdoors on organic material such as bread, fruit and damp walls."
);

const INDUSTRIAL = chunk(
  "c4",
  "Industrial Revolution",
  "The Industrial Revolution was a transition to new manufacturing processes in Great Britain, continental Europe, and the United States, from around 1760 to about 1820–1840. " +
    "This transition included going from hand production methods to machines and new chemical manufacturing processes. " +
    "The textile industry was the first to use modern production methods, and textiles became the dominant industry in terms of employment and value of output. " +
    "Many of the technological and architectural innovations were of British origin. " +
    "Economic historians agree that the onset of the Industrial Revolution is the most important event in human history since the domestication of animals and plants."
);
const FRENCH = chunk(
  "c5",
  "French Revolution",
  "The French Revolution was a period of political and societal change in France that began with the Estates General of 1789 and ended with the coup of 18 Brumaire in November 1799. " +
    "Many of its ideas are considered fundamental principles of liberal democracy, while its values and institutions remain central to modern French political discourse. " +
    "Its causes are generally agreed to be a combination of social, political, and economic factors which the existing regime proved unable to manage. " +
    "Financial crisis and widespread social distress led to the convocation of the Estates General in May 1789."
);

describe("splitSentences", () => {
  it("keeps abbreviations and decimals inside a sentence", () => {
    expect(splitSentences("The U.S. has 3.5 million. It grew, e.g. in 2020. Done!")).toEqual([
      "The U.S. has 3.5 million.",
      "It grew, e.g. in 2020.",
      "Done!",
    ]);
  });
});

describe("compressContext", () => {
  const chunks = [CANBERRA, SYDNEY, MOLD, INDUSTRIAL, FRENCH];

  it("cuts prompt tokens for a lookup and drops the unrelated chunk", () => {
    const r = compressContext("What is the capital of Australia?", chunks, { tokenBudget: 300 });
    expect(r.tokensAfter).toBeLessThanOrEqual(300);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore * 0.5);
    expect(r.chunks.map((c) => c.title)).not.toContain("Mold");
    expect(r.chunks[0].body).toMatch(/^Canberra is the capital city of Australia\./);
    // Measured numbers, printed for the PR evidence.
    console.log(`[compress] lookup: ${r.tokensBefore} -> ${r.tokensAfter} approx tokens`);
  });

  it("keeps both sides of a comparison within the default 1.2k budget", () => {
    const r = compressContext("Compare the causes of the French Revolution and the Industrial Revolution", chunks);
    const titles = r.chunks.map((c) => c.title);
    expect(titles).toContain("French Revolution");
    expect(titles).toContain("Industrial Revolution");
    expect(r.tokensAfter).toBeLessThanOrEqual(1200);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    console.log(`[compress] compare: ${r.tokensBefore} -> ${r.tokensAfter} approx tokens`);
  });

  it("orders kept chunks by relevance (that order is the [n] numbering) and reports kept indices", () => {
    const r = compressContext("Who designed Canberra, the capital of Australia?", [SYDNEY, MOLD, CANBERRA]);
    expect(r.chunks[0].title).toBe("Canberra");
    r.chunks.forEach((c, i) => expect(c.chunkId).toBe([SYDNEY, MOLD, CANBERRA][r.keptIndices[i]].chunkId));
  });

  it("restores document order inside a chunk and opens with its first sentence", () => {
    const r = compressContext("Who designed Canberra?", [CANBERRA], { tokenBudget: 1200 });
    const body = r.chunks[0].body;
    expect(body.indexOf("Canberra is the capital")).toBe(0);
    expect(body).toMatch(/Walter Burley Griffin/);
  });

  it("falls back to opening sentences when nothing matches, and honors a real tokenizer", () => {
    let calls = 0;
    const r = compressContext("zzz qqq", chunks, {
      tokenBudget: 200,
      countTokens: (s) => {
        calls++;
        return approxTokens(s);
      },
    });
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.tokensAfter).toBeLessThanOrEqual(200);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("mergeSources", () => {
  it("numbers a chunk retrieved twice once, and maps each list to global indices", () => {
    const { sources, indexMaps } = mergeSources([
      [CANBERRA, SYDNEY],
      [SYDNEY, MOLD],
    ]);
    expect(sources.map((s) => s.chunkId)).toEqual(["c1", "c2", "c3"]);
    expect(indexMaps).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});


describe("post-quantum question (Vitalik, on camera)", () => {
  // Real Wikipedia excerpts, classic-crypto distractors first (as retrieval returned them on device).
  const chunks = PQ_FIXTURE.chunks as RetrievedChunk[];
  const query = "Which signature algorithms are quantum resistant?";
  const PQ = /\b(ML-DSA|Dilithium|Falcon|SPHINCS\+?)/;

  it("keeps the quantum-resistant schemes through the 1.2k-token budget, unbroken", () => {
    const r = compressContext(query, chunks, { tokenBudget: 1200 });
    const all = r.chunks.map((c) => c.body).join("\n");
    expect(all).toContain("CRYSTALS-Dilithium, a quantum-resistant scheme based on LWE in lattices");
    expect(all).toContain("Falcon, a quantum-resistant scheme based on CVP in lattices");
    expect(all).toContain("SPHINCS+, a quantum-resistant scheme based on hash functions");
    // A soft line wrap in the source must not split the sentence naming ML-DSA.
    expect(all).toMatch(/ML-DSA \(commonly known as Dilithium\) were among the first post-quantum algorithms standardised by NIST/);
    console.log(`[compress] post-quantum: ${r.tokensBefore} -> ${r.tokensAfter} approx tokens, kept ${r.chunks.map((c) => c.title).join(" | ")}`);
  });

  it("cites a post-quantum source as [1] and drops the RSA distractor", () => {
    const r = compressContext(query, chunks, { tokenBudget: 1200 });
    // Retrieval returned RSA and ECDSA first; after compression the source numbered [1] names the schemes.
    expect(r.chunks[0].body).toMatch(PQ);
    expect(r.chunks.map((c) => c.title)).not.toContain("RSA cryptosystem");
    // ECDSA may stay as context (it is a signature algorithm, useful as the non-resistant contrast), never first.
    expect(r.chunks[0].title).not.toBe("Elliptic Curve Digital Signature Algorithm");
  });

  it("still keeps them when the budget is tight (600 tokens), ahead of RSA/ECDSA text", () => {
    const r = compressContext(query, chunks, { tokenBudget: 600 });
    const all = r.chunks.map((c) => c.body).join("\n");
    expect(all).toMatch(PQ);
    expect(r.tokensAfter).toBeLessThanOrEqual(600);
  });

});

describe("compressContext keeps the rest of a chosen passage when the budget allows (RF-1, Plate tectonics)", () => {
  const c = (id: string, title: string, body: string) => ({ chunkId: id, docId: id, title, body, score: 1, matchType: "lexical" as const });
  it("all four sentences of the passage; the distractor still out", () => {
    const plates = c("p", "Plate tectonics", "Plate tectonics is the theory that Earth's lithosphere comprises large tectonic plates. The model builds on the concept of continental drift. Plates meet at boundaries where earthquakes occur. The processes that shape Earth's crust are called tectonics.");
    const noise = c("n", "Lagrange point", "A Lagrange point is where the gravitational forces of two bodies balance. Earthquakes are not relevant here.");
    const out = compressContext("Why do earthquakes happen near plate boundaries?", [plates, noise]).chunks;
    const p = out.find((x) => x.chunkId === "p")!;
    expect(p.body).toContain("continental drift");
    expect(p.body).toContain("are called tectonics");
  });
  it("only the most relevant passage is filled (Boar: prefill cost)", () => {
    const plates = c("p", "Plate tectonics", "Plate tectonics is the theory of large tectonic plates. The model builds on continental drift. Plates meet at boundaries where earthquakes occur.");
    const quake = c("q", "Earthquake", "An earthquake is the shaking of the surface of the Earth. Most occur at plate boundaries. Seismometers record them all over the world.");
    const out = compressContext("Why do earthquakes happen near plate boundaries?", [plates, quake]).chunks;
    const filled = out.filter((x) => /continental drift|Seismometers/.test(x.body));
    expect(filled).toHaveLength(1);
  });

  it("a tight budget still keeps only the matching sentences", () => {
    const plates = c("p", "Plate tectonics", "Plate tectonics is the theory of large plates. The model builds on continental drift and many other long ideas from the twentieth century. Plates meet at boundaries where earthquakes occur.");
    const out = compressContext("Why do earthquakes happen near plate boundaries?", [plates], { tokenBudget: 30 }).chunks;
    expect(out[0].body).not.toContain("continental drift");
  });
});


describe("compressForAnswer (fast-answer budget)", () => {
  it("keeps a lookup within its budget and passes an empty list through", () => {
    const out = compressForAnswer("What is the capital of Australia?", [CANBERRA, SYDNEY, MOLD], "lookup");
    expect(out.tokensAfter).toBeLessThanOrEqual(FAST_CONTEXT_TOKENS.lookup + 20);
    expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
    expect(out.chunks[0].title).toBe("Canberra");
    expect(compressForAnswer("anything", [], "lookup")).toEqual({ chunks: [], keptIndices: [], tokensBefore: 0, tokensAfter: 0 });
  });
});
