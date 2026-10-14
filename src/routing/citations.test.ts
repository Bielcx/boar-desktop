import { describe, it, expect } from "vitest";
import { attributeCitations, checkCitations, citationSupport, dedupeCitations } from "./citations";
import type { RetrievedChunk } from "../rag/retrieve.types";

const src = (title: string, body: string): RetrievedChunk => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" });
const WALIPINI = src("Appropedia: Walipini", "A Walipini is an earth-sheltered cold frame. It takes advantage of the heat stored in the earth during the cold season.");
const NOSEBLEED = src("Nosebleed", "Treatment: Most anterior nosebleeds can be stopped by applying direct pressure. Apply pressure to the soft part of the nose by pinching it, and tilt the head forward.");
const PQC = src("Post-quantum cryptography", "Post-quantum cryptography is the development of cryptographic algorithms that are thought to be secure against a cryptanalytic attack by a quantum computer.");

describe("checkCitations (CT-1)", () => {
  it("drops [1] when the source doesn't say it (the 1.5B's seasons answer on device)", () => {
    const r = checkCitations("Earth's axial tilt causes the seasons [1]. Summer comes when your hemisphere leans toward the Sun.", [WALIPINI]);
    expect(r.text).toBe("Earth's axial tilt causes the seasons. Summer comes when your hemisphere leans toward the Sun.");
    expect(r.removed).toEqual([1]);
  });

  it("keeps a citation the source supports", () => {
    const answer = "To stop a nosebleed, apply pressure by pinching the soft part of the nose and tilt the head forward [1].";
    expect(checkCitations(answer, [NOSEBLEED])).toEqual({ text: answer, removed: [], moved: [] });
  });

  it("drops a claim the source doesn't carry even when the topic matches (names from memory)", () => {
    const r = checkCitations("Quantum-resistant signatures include Dilithium, Falcon and SPHINCS+, selected by NIST [1].", [PQC]);
    expect(r.removed).toEqual([1]);
    expect(r.text).toBe("Quantum-resistant signatures include Dilithium, Falcon and SPHINCS+, selected by NIST.");
  });

  it("drops a number past the sources, and handles '. [1]' and several citations", () => {
    expect(checkCitations("Pinch the soft part of the nose. [1] It was built in 1912 [3].", [NOSEBLEED]).text).toBe("Pinch the soft part of the nose. [1] It was built in 1912.");
    expect(checkCitations("Pinch the nose [1][2].", [NOSEBLEED]).removed).toEqual([2]);
  });

  it("support is the share of the sentence's key words found in the source", () => {
    expect(citationSupport("Earth's axial tilt causes the seasons", WALIPINI)).toBeLessThan(0.5);
    expect(citationSupport("apply pressure by pinching the soft part of the nose", NOSEBLEED)).toBeGreaterThan(0.8);
  });
});

describe("checkCitations in English: paraphrase of a short source (iPhone 13, 28/09)", () => {
  // Real prompt source and answers (desktop replay of the app pipeline, seeds 1-3; the device texts were not logged).
  const GREENHOUSE = src(
    "Greenhouse effect",
    "The greenhouse effect occurs when heat-trapping gases in a planet's atmosphere prevent the planet from losing heat to space, raising its surface temperature. Surface heating can happen from an internal heat source or come from an external source, such as a host star. In the case of Earth, the Sun emits shortwave radiation (sunlight) that passes through greenhouse gases to heat the Earth's surface. In response, the Earth's surface emits longwave radiation that is mostly absorbed by greenhouse gases, reducing the rate at which the Earth can cool off."
  );
  const AVOGADRO = src(
    "Amedeo Avogadro",
    "Lorenzo Romano Amedeo Carlo Avogadro, Count of Quaregna and Cerreto (, also US: , Italian: [ameˈdɛːo avoˈɡaːdro]; 9 August 1776 – 9 July 1856) was an Italian scientist, most noted for his contribution to molecular theory now known as Avogadro's law, which states that equal volumes of gases under the same conditions of temperature and pressure will contain equal numbers of molecules. In tribute to him, the ratio of the number of elementary entities (atoms, molecules, ions or other particles) in a substance to its amount of substance (the latter having the unit mole), 6.02214076×1023 mol−1, is known as the Avogadro constant."
  );

  it("keeps the 4B's greenhouse citation: 'like', 're-' and 'radiate'/'radiation' no longer count against it", () => {
    const answer = "Greenhouse gases like carbon dioxide and water vapor absorb this radiation and re-radiate it, trapping heat and warming the atmosphere [1].";
    expect(checkCitations(answer, [GREENHOUSE]).removed).toEqual([]);
  });

  it("a [1] closing a whole explanation vouches for the paragraph (the 1.5B's style), at the bar for adding one", () => {
    const answer =
      "The greenhouse effect is when heat-trapping gases in Earth's atmosphere trap heat from the sun, warming the planet's surface. When the sun emits shortwave radiation, it passes through the atmosphere and heats the Earth's surface. The Earth then emits longwave radiation, mostly absorbed by greenhouse gases, reducing cooling. This cycle keeps Earth warm, essential for life. [1]";
    expect(checkCitations(answer, [GREENHOUSE])).toEqual({ text: answer, removed: [], moved: [] });
    // Loose word overlap over a paragraph is not support (the 4B, gate c7a7f17: 0.5 as one claim).
    expect(checkCitations("The United States has 50 states. The element with atomic number 50 is tin (Sn). [1]", [AVOGADRO]).removed).toEqual([1]);
    // Inside a paragraph a citation still answers for its own sentence.
    expect(checkCitations("This cycle keeps Earth warm, essential for life [1]. The greenhouse effect traps heat.", [GREENHOUSE]).removed).toEqual([1]);
  });

  it("stays off-topic-proof: the seasons from the Walipini and the Irish famine from the Great Recession", () => {
    expect(checkCitations("Earth's axial tilt causes the seasons [1].", [WALIPINI]).removed).toEqual([1]);
    const recession = src("Great Recession in Africa", "As a direct result of the late 2000s recession, some economies in Africa have been primarily affected by reduced global demand and lower prices of commodities such as oil, platinum, nickel, gold, and copper.");
    const famine = "The Great Famine in Ireland was primarily caused by the late 19th century potato blight, which reduced the potato crop yield to nearly zero. The consequences included mass starvation and emigration of Irish people to other countries. [1]";
    expect(checkCitations(famine, [recession]).removed).toEqual([1]);
  });
});

describe("checkCitations: a [n] on the wrong sentence of its paragraph moves (desktop bench, 1.5B)", () => {
  // Real corpus intro and 1.5B answer (bench grounded-2): the [1] closes the sentence from memory.
  const BLACK_HOLE = src(
    "Black hole",
    "A black hole is an astronomical body so compact that its gravity prevents anything, including light, from escaping. Albert Einstein's theory of general relativity, which describes gravitation as the curvature of spacetime, predicts that any sufficiently compact mass will form a black hole. The boundary of no escape is called the event horizon."
  );

  it("moves the [1] to the sentence the source supports, instead of dropping it", () => {
    const answer =
      "A black hole is an astronomical body with such a strong gravitational field that nothing, not even light, can escape its pull. They form from massive stars that collapse in on themselves after their fuel is used up. [1]";
    expect(checkCitations(answer, [BLACK_HOLE])).toEqual({
      text: "A black hole is an astronomical body with such a strong gravitational field that nothing, not even light, can escape its pull [1]. They form from massive stars that collapse in on themselves after their fuel is used up.",
      removed: [],
      moved: [1],
    });
  });

  it("only within its paragraph, never to a short sentence, and never to an unsupported one", () => {
    // Before an earlier citation: not this citation's paragraph.
    expect(checkCitations("Light cannot escape a black hole [1]. Stars collapse at the end of their fuel [1].", [BLACK_HOLE]).moved).toEqual([]);
    // "It is dark." has under two key words: support 1 by definition, but it never takes the [n].
    expect(checkCitations("It is dark. Stars collapse at the end of their fuel [1].", [BLACK_HOLE])).toMatchObject({ removed: [1], moved: [] });
    // The Irish famine from the Great Recession: no sentence of the paragraph earns it.
    const recession = src("Great Recession in Africa", "As a direct result of the late 2000s recession, some economies in Africa have been primarily affected by reduced global demand and lower prices of commodities such as oil, platinum, nickel, gold, and copper.");
    const famine = "The Great Famine in Ireland was primarily caused by the late 19th century potato blight, which reduced the potato crop yield to nearly zero. The consequences included mass starvation and emigration of Irish people to other countries. [1]";
    expect(checkCitations(famine, [recession])).toMatchObject({ removed: [1], moved: [] });
  });
});

describe("attributeCitations (the inverse of CT-1)", () => {
  const src = (title: string, body: string) => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" as const });
  const MONSOON = src("Monsoon", "A monsoon is a seasonal reversing wind accompanied by changes in precipitation.");
  const GREEN = src("Greenhouse effect", "The greenhouse effect occurs when greenhouse gases in the atmosphere trap heat radiated by the surface.");
  it("adds the [n] of the source that supports a sentence, the best one", () => {
    const r = attributeCitations("A monsoon is a seasonal reversing wind. Greenhouse gases trap heat in the atmosphere.", [MONSOON, GREEN]);
    expect(r.text).toBe("A monsoon is a seasonal reversing wind [1]. Greenhouse gases trap heat in the atmosphere [2].");
    expect(r.added).toEqual([1, 2]);
  });
  it("gate 9ef80f9, real answer: a wrong sentence that shares half its words with the source gets no [n]", () => {
    const pqc = src("Post-quantum cryptography", "Post-quantum cryptography refers to cryptographic algorithms that are secure against an attack by a quantum computer. Most widely used public-key algorithms rely on the integer factorization problem or the discrete logarithm problem, which a quantum computer could break. The Open Quantum Safe project provides liboqs, an open source library of quantum-resistant signature algorithms.");
    const wrong = "Quantum-resistant signature algorithms include those based on elliptic curve cryptography (ECC).";
    expect(attributeCitations(wrong, [pqc]).added).toEqual([]);
    expect(attributeCitations("Liboqs, an open-source library, integrates several quantum-resistant signature algorithms.", [pqc]).added).toEqual([1]);
  });

  it("Prism CIT-2: a citation written after the period belongs to that sentence (no '[1]. [1]')", () => {
    const r = attributeCitations("A monsoon is a seasonal reversing wind accompanied by changes in precipitation. [1]", [MONSOON]);
    expect(r.text).toBe("A monsoon is a seasonal reversing wind accompanied by changes in precipitation. [1]");
    expect(r.added).toEqual([]);
  });

  it("never cites a heading or a bold title line, only the sentences under it", () => {
    const r = attributeCitations("## Greenhouse gases trap heat in the atmosphere\n\n**Greenhouse gases trap heat in the atmosphere**\n\nGreenhouse gases trap heat in the atmosphere.", [GREEN]);
    expect(r.text).toBe("## Greenhouse gases trap heat in the atmosphere\n\n**Greenhouse gases trap heat in the atmosphere**\n\nGreenhouse gases trap heat in the atmosphere [1].");
    expect(r.added).toEqual([1]);
  });

  it("never without support, never to a short sentence, never twice", () => {
    expect(attributeCitations("Ice cream is sold on beaches.", [MONSOON]).added).toEqual([]);
    expect(attributeCitations("Monsoon.", [MONSOON]).added).toEqual([]);
    expect(attributeCitations("A monsoon is a seasonal reversing wind [1].", [MONSOON]).text).toBe("A monsoon is a seasonal reversing wind [1].");
  });
});

describe("dedupeCitations (Prism CIT-2)", () => {
  it("one [n] per sentence end", () => {
    expect(dedupeCitations("The ITCZ moves [1]. [1]")).toBe("The ITCZ moves [1].");
    expect(dedupeCitations("The ITCZ moves [1] [1].")).toBe("The ITCZ moves [1].");
    expect(dedupeCitations("A [1]. B [2].")).toBe("A [1]. B [2].");
    expect(dedupeCitations("A [1] [2].")).toBe("A [1] [2].");
  });
});
