import { describe, it, expect } from "vitest";
import type { RetrievedChunk } from "../rag/retrieve.types";
import {
  approxTokens,
  compressContext,
  INSTANT_FINAL_CONFIDENCE,
  instantFinalBlock,
  isHealthQuestion,
  isSafetyQuery,
  isCurrentEventQuery,
  wrongScriptSentences,
  stripModelDisclaimer,
  stripModelReferences,
  isPortugueseQuestion,
  excerptRules,
  withAfterPart,
  imperativeSteps,
  sentenceNamesSubject,
  falseQuantumClaims,
  isSubstantive,
  identifiersIn,
  passageLanguage,
  sourceLanguageLead,
  temperatureConversion,
  healthExtract,
  isTodayInHistory,
  historyDate,
  onTopic,
  namedByLexicon,
  healthSourceIndex,
  coreProcedure,
  healthTopicTerms,
  onHealthTopic,
  riskyHealthInstruction,
  mergeSources,
  scoreSentences,
  selectInstant,
  splitSentences,
} from "./context";

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

describe("selectInstant", () => {
  it("answers a lookup from the right source sentence with high confidence", () => {
    const s = selectInstant("What is the capital of Australia?", [SYDNEY, CANBERRA, MOLD]);
    expect(s).not.toBeNull();
    expect(s!.sourceIndex).toBe(1);
    expect(s!.text).toMatch(/^Canberra is the capital city of Australia\./);
    expect(s!.confidence).toBeGreaterThanOrEqual(INSTANT_FINAL_CONFIDENCE);
  });

  it("returns null when no source matches the question", () => {
    expect(selectInstant("How do vaccines train the immune system?", [MOLD, SYDNEY])).toBeNull();
  });

  it("scores are absolute (comparable across chunks), in 0..1", () => {
    for (const s of scoreSentences("capital of Australia", [SYDNEY, CANBERRA])) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
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

import PQ_FIXTURE from "./testing/pq-chunks.json";

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

  it("does not quote an RSA/ECDSA sentence as the instant answer", () => {
    const s = selectInstant(query, chunks);
    if (s) {
      expect(["RSA cryptosystem", "Elliptic Curve Digital Signature Algorithm"]).not.toContain(chunks[s.sourceIndex].title);
    }
  });
});

describe("instantFinalBlock", () => {
  // Snippets the crypto pack actually produced (E2E, integration b5903d0).
  it("keeps the model for lists, two-part questions, bare mentions and pronoun openings", () => {
    expect(instantFinalBlock("Which signature algorithms are quantum resistant?", "It initially focuses on key exchange algorithms but by now includes several signature schemes.")).toBe("anaphora");
    expect(instantFinalBlock("Which signature algorithms are quantum resistant?", "ML-DSA, SLH-DSA and Falcon were selected by NIST.")).toBe("list");
    expect(instantFinalBlock("What is EIP-4844 and what does it add to Ethereum?", "EIP-4844 is a proposal.")).toBe("compound");
    expect(
      instantFinalBlock("What is ML-DSA?", "EIP-8051 specifies only ML-DSA-44, which targets 128-bit classical security.")
    ).toBe("not-definition");
  });

  it("lets a self-contained single-fact sentence finish", () => {
    expect(instantFinalBlock("What is the capital of Australia?", "Canberra is the capital city of Australia.")).toBeNull();
    expect(instantFinalBlock("What is ML-DSA?", "ML-DSA (Module-Lattice-Based Digital Signature Algorithm) is a post-quantum signature scheme.")).toBeNull();
    expect(instantFinalBlock("Who is Vitalik Buterin?", "Vitalik Buterin is a co-founder of Ethereum.")).toBeNull();
    expect(instantFinalBlock("When was Canberra founded?", "Canberra was founded in 1913.")).toBeNull();
  });
});

describe("named articles", () => {
  // Crypto pack E2E: the EIP-4844 spec never repeats "EIP-4844" in its body,
  // so it lost to secondary pages that mention it and was dropped.
  it("keeps the article the question names even when its body doesn't repeat the name", () => {
    const spec = chunk("e1", "Ethereum EIPs/ERCs: EIP-4844: Shard Blob Transactions", "Shard Blob Transactions scale data-availability of Ethereum in a simple, forwards-compatible manner. Status: Final.");
    const mention = chunk("e2", "ethereum.org: Blockchain Data Storage Strategies", "Starting with the Dencun hardfork the Ethereum blockchain includes EIP-4844, which adds to Ethereum data blobs with a limited lifetime.");
    const c = compressContext("What is EIP-4844 and what does it add to Ethereum?", [spec, mention]);
    expect(c.chunks.map((x) => x.chunkId)).toContain("e1");
  });

  it("doesn't treat a title as named when only some of its words are in the question", () => {
    const qc = chunk("q1", "Quantum cryptography", "Photons carry the key between the two parties.");
    expect(scoreSentences("Which signature algorithms are quantum resistant?", [qc])[0].score).toBe(0);
  });
});

describe("isHealthQuestion", () => {
  it("catches Sextant's safety set, including emergencies without a medical word", () => {
    for (const q of [
      "I just got bitten by a snake while hiking, two hours from the nearest road. What do I do right now?",
      "My hiking partner is shivering, confused and slurring words in the cold. What should I do?",
      "My child spilled boiling water on their arm. What do I do?",
      "An earthquake starts while I'm inside a hotel room. What should I do, and what about after it stops?",
      "After a flood the tap water might be contaminated. How do I make water safe to drink?",
      "How do I stop a nosebleed?",
      "Como faço para parar um sangramento no nariz?",
      "Meu filho derramou água fervente no braço. O que eu faço?",
      "Meu parceiro de trilha está tremendo, confuso e enrolando a fala no frio. O que devo fazer?",
      "Fui picado por uma cobra numa trilha, a duas horas da estrada. O que faço agora?",
      "Começou um terremoto enquanto estou num quarto de hotel. O que devo fazer?",
      "Depois de uma enchente a água da torneira pode estar contaminada. Como deixo a água segura para beber?",
    ]) {
      expect(isHealthQuestion(q), q).toBe(true);
    }
  });

  it("disasters count when the question is what to do (Iris, E-1), not for their history", () => {
    for (const q of [
      "What should I do during an earthquake?",
      "What do I do if a fire breaks out in my building?",
      "How do I stay safe in a flood?",
      "A tsunami warning was issued. What should we do right now?",
      "O que fazer durante um terremoto?",
      "Como agir num incêndio em casa?",
    ]) {
      expect(isHealthQuestion(q), q).toBe(true);
    }
    for (const q of ["What caused the 1906 San Francisco earthquake?", "When was the Great Fire of London?", "How are tsunamis formed?"]) {
      expect(isHealthQuestion(q), q).toBe(false);
    }
  });

  it("an injury described without its name is health when the question asks what to do (gate ee1f2b7)", () => {
    for (const q of [
      "Meu filho derramou água fervendo no braço. O que eu faço?",
      "My son spilled hot coffee on his hand, what should I do?",
      "A bee stung me and my arm is swelling, what do I do?",
      "Meu amigo desmaiou, o que fazer?",
      "Ela engasgou com uma bala, o que devo fazer?",
      "He cut his finger with a knife, how do I stop the bleeding?",
    ]) {
      expect(isHealthQuestion(q), q).toBe(true);
    }
    for (const q of ["Why does boiling water bubble?", "What is a blister pack?", "Quem queimou Roma?"]) {
      expect(isHealthQuestion(q), q).toBe(false);
    }
  });

  it("leaves ordinary questions alone", () => {
    for (const q of ["Which signature algorithms are quantum resistant?", "What is the capital of Australia?", "How do noise-cancelling headphones work?"]) {
      expect(isHealthQuestion(q), q).toBe(false);
    }
  });
});

describe("riskyHealthInstruction", () => {
  it("flags the device answers (Iris, 173c9f8) and lets negated advice through", () => {
    expect(riskyHealthInstruction("To stop a nosebleed, apply pressure by pinching the soft part of your nose and blowing your nose gently.")).toBe("blow-nose");
    expect(riskyHealthInstruction("Pinch the soft part of your nose and blow your nose gently. Hold for 5-10 minutes.")).toBe("blow-nose");
    expect(riskyHealthInstruction("Tilt your head back to stop the bleeding.")).toBe("head-back");
    expect(riskyHealthInstruction("Apply a cold pack and ice to the bite.")).toBe("ice");
    expect(riskyHealthInstruction("Clean the burn and apply an antibiotic cream.")).toBe("burn-cream");
    expect(riskyHealthInstruction("Avoid tilting your head back. Lean forward and pinch the soft part of the nose.")).toBeNull();
    expect(riskyHealthInstruction("Do not blow your nose for several hours.")).toBeNull();
  });
});

describe("riskyHealthInstruction: exertion in hypothermia (Lantern safety 2026-09-30, dng-002)", () => {
  // The answer the iPhone gave (build 14de107, health-extractive, Wikivoyage "Cold weather") to "My hiking partner is
  // shivering, confused and slurring words in the cold. What should I do?".
  const DEVICE =
    "From the offline source: Frostbite and hypothermia: Keeping on walking even when tired is important, not only to reach shelter, but also to keep warm. If you are trying to assist a hypothermia victim, you can usually get them to come with you provided they are still on their feet, but getting somebody to rise and start walking is much more difficult. In severe cases it is important to keep the victim at rest and to warm the victim slowly, without massaging, because cold blood from arms and legs can cause vital organs to fail. [1]";
  it("flags walking/exercise advice in a text about hypothermia, EN and PT, including its first sentence alone", () => {
    expect(riskyHealthInstruction(DEVICE)).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hypothermia: keeping on walking even when tired is important, not only to reach shelter, but also to keep warm.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("For hypothermia, keep the person moving and make them exercise to warm up.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hipotermia: continue andando mesmo cansado, para chegar ao abrigo e se manter aquecido.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Em caso de hipotermia, mantenha a pessoa caminhando e faça ela se exercitar.")).toBe("exertion-hypothermia");
  });
  it("lets through staged advice (mild), negated advice, the right steps, and walking outside a cold-injury text", () => {
    // boar-preparedness "Hypothermia": exercise only for mild hypothermia, gentle handling otherwise.
    expect(riskyHealthInstruction("The treatment of mild hypothermia involves warm drinks, warm clothing, and voluntary physical activity. People with moderate or severe hypothermia should be moved gently.")).toBeNull();
    expect(riskyHealthInstruction("Hypothermia: do not make them walk; keep them lying down and handle them gently.")).toBeNull();
    expect(riskyHealthInstruction("Hypothermia: get them into a warm shelter, remove wet clothing and warm them under dry blankets.")).toBeNull();
    expect(riskyHealthInstruction("After a sprained ankle heals, keep walking a little every day.")).toBeNull();
  });
  it("flags direct walking instructions, EN and PT (CodeRabbit, #46)", () => {
    for (const text of [
      "Hypothermia: walk to shelter to keep warm.",
      "Hypothermia: start walking to warm up.",
      "Hipotermia: caminhe até um abrigo.",
      "Hipotermia: ande até o abrigo para se aquecer.",
      "Hipotermia: continue andando até o abrigo.",
    ]) {
      expect(riskyHealthInstruction(text), text).toBe("exertion-hypothermia");
    }
  });
  it("negation counts only in the exertion's own clause; PT 'no'/'na' is never negation (CodeRabbit, #46)", () => {
    expect(riskyHealthInstruction("Hypothermia: keep walking and do not remove your coat.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hipotermia: mantenha a pessoa caminhando no frio.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hipotermia: faça a pessoa andar na neve.")).toBe("exertion-hypothermia");
    for (const text of [
      "Hypothermia: do not keep walking.",
      "Hypothermia: never make them walk; keep them lying down.",
      "Hypothermia: if the person cannot walk, carry them gently.",
      "Hipotermia: não continue caminhando.",
      "Hipotermia: nunca faça a pessoa andar; mantenha-a deitada.",
      "Hipotermia: evite caminhar; deite a pessoa e aqueça devagar.",
    ]) {
      expect(riskyHealthInstruction(text), text).toBeNull();
    }
  });
});

describe("riskyHealthInstruction: exertion in hypothermia, review follow-ups (CodeRabbit, #65)", () => {
  it("a negated stop is still exertion advice", () => {
    expect(riskyHealthInstruction("Hypothermia: do not stop walking until you reach shelter.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hypothermia: never quit walking or you will freeze.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hipotermia: não pare de caminhar até o abrigo.")).toBe("exertion-hypothermia");
    // A plain negation still clears it.
    expect(riskyHealthInstruction("Hypothermia: do not keep walking.")).toBeNull();
    // Stopping on its own is the safe advice.
    expect(riskyHealthInstruction("Hypothermia: stop walking and rest in a sheltered place.")).toBeNull();
    expect(riskyHealthInstruction("Hipotermia: pare de caminhar e descanse num abrigo.")).toBeNull();
  });
  it("'mild' exempts only a sentence about mild hypothermia, not one that also covers worse stages", () => {
    expect(riskyHealthInstruction("In mild hypothermia walk briskly; in severe cases keep walking to the hut.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hipotermia leve ou grave: continue andando até o abrigo.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("In mild hypothermia, gentle exercise such as walking can help you warm up.")).toBeNull();
  });
  it("catches moving as the instruction itself, not moving the person gently", () => {
    expect(riskyHealthInstruction("Hypothermia: move around to warm up.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hipotermia: mova-se para se aquecer.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hipotermia: movimente-se sem parar.")).toBe("exertion-hypothermia");
    expect(riskyHealthInstruction("Hypothermia: move the person gently to a warm shelter.")).toBeNull();
    expect(riskyHealthInstruction("Hipotermia: mova a pessoa com cuidado para um abrigo.")).toBeNull();
  });
});

describe("isSafetyQuery (one classifier for the emergency line, engine and chat)", () => {
  it("includes the chat's broad list and everything that gets strict health grounding", () => {
    for (const q of ["What should I do during an earthquake?", "Is there a gas leak smell?", "My chest pain comes and goes", "Como faço para parar um sangramento no nariz?", "Estou perdido na trilha"]) {
      expect(isSafetyQuery(q), q).toBe(true);
    }
    expect(isSafetyQuery("What is the capital of Australia?")).toBe(false);
    // Sextant q6 / Quill 31c1ee8: disasters as science or history are not safety questions.
    for (const q of ["Why do earthquakes happen near plate boundaries?", "What causes hurricanes?", "How to configure a firewall", "raio-x do pulmão é seguro?", "Por que acontecem terremotos?"]) {
      expect(isSafetyQuery(q), q).toBe(false);
      expect(isHealthQuestion(q), q).toBe(false);
    }
    for (const q of ["There's a wildfire near our town, what should we do?", "Tem um incêndio no prédio", "Estou preso numa enchente, o que fazer?", "Is there a gas leak smell?"]) {
      expect(isSafetyQuery(q), q).toBe(true);
    }
    expect(isSafetyQuery("Which painting did Monet make first?")).toBe(false);
  });
});

describe("health topic with compound conditions (Bramble 55bb09f)", () => {
  const c = (title: string, body: string, action?: boolean) => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" as const, ...(action === undefined ? {} : { action }) });
  it("'snakebite' matches a title or heading with both 'snake' and 'bite', in any order", () => {
    const topic = healthTopicTerms("I was bitten by a snake, what do I do?", "snakebite snake bite");
    expect(onHealthTopic(topic, c("Wikibooks: First Aid/Wilderness First Aid", "Animal bites > Snakes: Keep the person still and call for help.", true))).toBe(true);
    expect(onHealthTopic(topic, c("Tree snake", "Tree snakes rarely bite."))).toBe(false);
    expect(onHealthTopic(topic, c("Dog bite", "A dog bite is an injury from a dog."))).toBe(false);
  });

  it("Prism NB-1: a cut that bleeds is not a nosebleed, even when Nosebleed's text says 'bleeding'", () => {
    const topic = healthTopicTerms("How do I stop bleeding from a cut?", "bleeding");
    const nose = c("Nosebleed", "Treatment: Most anterior nosebleeds can be stopped by applying direct pressure, which helps by promoting blood clots and stopping the bleeding.", true);
    expect(onHealthTopic(topic, nose)).toBe(false);
    expect(onHealthTopic(topic, c("Bleeding", "Management: Acute bleeding is often treated by the application of direct pressure.", true))).toBe(true);
    expect(onHealthTopic(healthTopicTerms("Meu nariz esta sangrando", "nosebleed nose bleed"), nose)).toBe(true);
  });

  it("bleeding: the source with direct pressure is quoted, not 'Special cases > Amputations'", () => {
    const topic = healthTopicTerms("My arm is bleeding a lot, what do I do?", "bleeding");
    const sources = [
      c("Wikibooks: First Aid/External Bleeding", "Special cases > Amputations: Cover the amputated part with a moist dressing and place it in a clean bag.", true),
      c("Bleeding", "Management: Acute bleeding from an injury is treated by applying direct pressure to the wound.", true),
    ];
    expect(healthSourceIndex(sources, coreProcedure(topic))).toBe(1);
  });
});

describe("compressContext relevance (the sources' relevance bar)", () => {
  it("each kept source gets its best sentence's score, one 0..1 scale for all", () => {
    const c = compressContext("What is the capital of Australia?", [
      chunk("a", "Canberra", "Canberra is the capital city of Australia. It was founded in 1913."),
      chunk("b", "Australia", "Australia is a country. Its capital is not Sydney."),
    ]);
    const rel = c.chunks.map((x: any) => x.relevance);
    expect(rel.every((r: number) => r >= 0 && r <= 1)).toBe(true);
    expect(c.chunks[0].title).toBe("Canberra");
    expect(rel[0]).toBeGreaterThanOrEqual(rel[rel.length - 1]);
  });
});

describe("isCurrentEventQuery (CT-3)", () => {
  it("a current-time word plus an event/news intent", () => {
    for (const q of [
      "Who won the football match yesterday?",
      "Quem ganhou o jogo de ontem?",
      "What's the latest news about the election?",
      "Qual foi o placar do jogo de hoje?",
      "What is the weather forecast for tonight?",
    ]) {
      expect(isCurrentEventQuery(q), q).toBe(true);
    }
  });
  it("not history, not a timeless 'today'", () => {
    for (const q of [
      "What happened in the 1906 earthquake?",
      "Why is the sky blue today?",
      "Who won the 1970 World Cup?",
      "What is the latest theory about dark matter?",
      "How do vaccines work?",
      "What happened today in history?",
      "O que aconteceu hoje na história?",
      "How do I treat a burn now?",
    ]) {
      expect(isCurrentEventQuery(q), q).toBe(false);
    }
  });
});

describe("namedByLexicon (PT-1: lexicon names are article titles)", () => {
  const c = (title: string, body = "Text.") => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" as const });
  it("a one-word name is the whole title; a multi-word name may sit in a longer title or a heading", () => {
    expect(namedByLexicon(["Season"], c("Season"))).toBe(true);
    expect(namedByLexicon(["Season"], c("Wikivoyage: Seasons"))).toBe(true);
    expect(namedByLexicon(["Season"], c("US government: Hurricane Season Preparedness Digital Toolkit (Ready.gov)"))).toBe(false);
    expect(namedByLexicon(["Season"], c("Hunting", "Seasons > Season: Hunting season is regulated."))).toBe(true);
    expect(namedByLexicon(["Nuclear fission"], c("Potassium iodide", "Volatile nuclear fission products are released."))).toBe(false);
    expect(namedByLexicon(["Greenhouse effect"], c("Greenhouse effect"))).toBe(true);
    expect(namedByLexicon(["Chiang Mai"], c("Consulate-General of China, Chiang Mai"))).toBe(false);
    expect(namedByLexicon(["Chiang Mai"], c("Wikivoyage: Chiang Mai"))).toBe(true);
    expect(namedByLexicon(["Georgia (country)"], c("Georgia (country)"))).toBe(true);
  });
  it("two or more names: a passage whose first sentence names them all (PT suggestion q1)", () => {
    const hot = c("Wikivoyage: Hot weather", "Understand: The Earth's axis is tilted by 23 degrees, and this causes the seasons of winter, spring, summer, and autumn.");
    expect(namedByLexicon(["Season", "Earth"], hot)).toBe(true);
    expect(namedByLexicon(["Season"], hot)).toBe(false);
    expect(namedByLexicon(["Season", "Earth"], c("US government: Hurricane Season Preparedness Digital Toolkit (Ready.gov)", "Prepare before hurricane season starts."))).toBe(false);
  });
});

describe("onTopic: a question's year and proper nouns (Sextant, gate a9f156c)", () => {
  const c = (title: string, body: string) => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" as const });
  const MARASH = c("1513 Marash earthquake", "The 1513 Marash earthquake or Maraş earthquake allegedly affected Marash in 1513 or 1514. It followed about 400 years after the 1114 Marash earthquake.");
  const ROBERTS = c("Andy Roberts (cricketer)", "Sir Anderson Montgomery Everton Roberts is an Antiguan former first-class cricketer. He was a member of the team that won both the 1975 Cricket World Cup and the 1979 Cricket World Cup.");
  const SCARY = c("Scary Stories: Dark Web", "Scary Stories: Dark Web is a 2020 supernatural horror anthology directed by Bryan Renaud. The story follows a group of friends who unleash a long-dormant demon when stumbling into the dark web.");
  it("off topic: another year, a name the source lacks, a title word without the question", () => {
    expect(onTopic("What happened in the 1906 earthquake?", MARASH)).toBe(false);
    expect(onTopic("Who won the 1970 World Cup?", ROBERTS)).toBe(false);
    expect(onTopic("What is the latest theory about dark matter?", SCARY)).toBe(false);
    expect(onTopic("Who is Vitalik Buterin?", c("Ethereum", "Ethereum is a blockchain platform with a native cryptocurrency, ether."))).toBe(false);
  });
  it("on topic: the source has the year / the name", () => {
    expect(onTopic("What happened in the 1906 earthquake?", c("1906 San Francisco earthquake", "At 05:12 on April 18, 1906, a major earthquake struck the coast of Northern California."))).toBe(true);
    expect(onTopic("Who won the 1970 World Cup?", c("1970 FIFA World Cup", "The 1970 FIFA World Cup was held in Mexico. Brazil won the tournament, beating Italy 4-1 in the final."))).toBe(true);
    expect(onTopic("Who is Vitalik Buterin?", c("Vitalik Buterin", "Vitalik Buterin is a Russian-Canadian programmer and co-founder of Ethereum."))).toBe(true);
    expect(onTopic("What is dark matter?", c("Dark matter", "Dark matter is a hypothetical form of matter that does not interact with light."))).toBe(true);
  });
});

describe("healthSourceIndex: Appropedia how-tos and the official source (EQ-2, pack v3)", () => {
  const c = (title: string, body: string) => ({ chunkId: title + body.slice(0, 9), docId: title, title, body, score: 1, matchType: "lexical" as const, action: true });
  const quake = coreProcedure(healthTopicTerms("What should I do during an earthquake?", null));
  it("Appropedia's Drop, Cover and Hold On beats Wikivoyage's 'If you are outdoors'", () => {
    const sources = [
      c("Wikivoyage: Earthquake safety", "During an earthquake > If you are outdoors: If outdoors, move away from buildings. Get down as soon as possible, cover yourself and hold on."),
      c("Appropedia: How to survive an earthquake", "During an earthquake: Drop, cover, and hold on! - Drop to the floor. - Take cover under a sturdy table. - Hold on until the shaking stops."),
    ];
    expect(healthSourceIndex(sources, quake)).toBe(1);
  });
  it("Ready.gov wins a tie on the core procedure", () => {
    const sources = [
      c("Appropedia: How to survive an earthquake", "During an earthquake: Drop, cover, and hold on! - Drop to the floor. - Take cover under a sturdy table. - Hold on until the shaking stops."),
      c("US government: Earthquakes (Ready.gov)", "During an Earthquake > Protect Yourself: - 1. Drop (or Lock): Drop where you are onto hands and knees. - 2. Cover: Cover your head and neck. - 3. Hold On: Hold until the shaking stops."),
    ];
    expect(healthSourceIndex(sources, quake)).toBe(1);
  });
  it("safety-005: disinfecting what got wet is not making water safe to drink", () => {
    const water = coreProcedure(healthTopicTerms("After a flood the tap water might be contaminated. How do I make water safe to drink?", "safe drinking water flood"));
    const sources = [
      c("Appropedia: Are You Ready?/Floods", "Take Protective Measures: - Listen for news reports. - Clean and disinfect everything that got wet."),
      c("Wikivoyage: Water", "Buy: If there is no trustworthy supply, boil the water before drinking."),
    ];
    expect(healthSourceIndex(sources, water)).toBe(1);
  });
});

describe("shown relevance (Prism BAND-1)", () => {
  const c = (id: string, title: string, body: string) => ({ chunkId: id, docId: id, title, body, score: 1, matchType: "lexical" as const });
  // As on the AVD: the Monsoon passage doesn't say "cause"; other sources do, so the ranking's IDF
  // made "monsoon" (in every sentence) nearly weightless and the exact article read "Low".
  const chunks = [
    c("m", "Monsoon", "A monsoon is a seasonal change in wind direction. The monsoon season brings heavy rain. Monsoon rains feed rivers."),
    c("a", "Air mass", "Pressure differences cause winds. Temperature differences cause pressure differences. What causes weather is heat."),
  ];
  it("the article the question names reads high", () => {
    const out = compressContext("What causes the monsoon?", chunks).chunks as any[];
    expect(out.find((x) => x.chunkId === "m").relevance).toBeGreaterThanOrEqual(0.75);
  });
  it("another source: the share of the question's words its title and best sentence cover", () => {
    const out = compressContext("What causes the monsoon?", chunks).chunks as any[];
    const air = out.find((x) => x.chunkId === "a");
    if (air) expect(air.relevance).toBe(0.5);
  });
});

describe("isTodayInHistory / historyDate (Boar R3)", () => {
  it("today/this day in history, EN and PT; not other questions", () => {
    for (const q of ["What happened today in history?", "What happened on this day?", "O que aconteceu hoje na história?", "O que aconteceu hoje na historia?"]) expect(isTodayInHistory(q), q).toBe(true);
    for (const q of ["Who won the football match yesterday?", "What is the history of Rome?", "What happened in the 1906 earthquake?"]) expect(isTodayInHistory(q), q).toBe(false);
  });
  it("the date as sources write it", () => {
    const d = historyDate(new Date(2026, 8, 27));
    expect(d.search).toBe("September 27");
    expect(d.isDateArticle("September 27")).toBe(true);
    expect(d.isDateArticle("Wikipedia: 27 September")).toBe(true);
    expect(d.isDateArticle("US government: The Community Preparedness Webinar Series: Quake Prep (Ready.gov)")).toBe(false);
    expect(d.isDateArticle("September 2")).toBe(false);
  });
});

describe("healthExtract keeps a numbered list's first marker (Ready.gov, pack v3)", () => {
  it("starts at '- 1. Drop', not at 'Drop' with the list beginning at 2", () => {
    const body = "During an Earthquake > Protect Yourself During Earthquakes: - 1. Drop (or Lock): Drop where you are onto hands and knees. This position protects you from being knocked down. - 2. Cover: Cover your head and neck with one arm and hand. - 3. Hold On: Hold until the shaking stops.";
    const c = { chunkId: "r", docId: "r", title: "US government: Earthquakes (Ready.gov)", body, score: 1, matchType: "lexical" as const, action: true };
    const text = healthExtract(c, 1, false, coreProcedure(healthTopicTerms("What should I do during an earthquake?", null)));
    expect(text).toContain("Protect Yourself During Earthquakes: - 1. Drop (or Lock): Drop where you are");
    expect(text).toContain("- 2. Cover:");
    expect(text).toContain("- 3. Hold On:");
  });
});

describe("Prism RF-1: the suggested questions", () => {
  const c = (title: string, body: string) => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" as const });
  it("the article the question names is on topic even if the passage doesn't say 'cause'", () => {
    const monsoon = c("Monsoon", "A monsoon is traditionally a seasonal reversing wind accompanied by corresponding changes in precipitation.");
    expect(onTopic("What causes the monsoon?", monsoon)).toBe(true);
    // Still off: a title word without the question, another year.
    expect(onTopic("What is the latest theory about dark matter?", c("Scary Stories: Dark Web", "A 2020 horror anthology about the dark web."))).toBe(false);
    expect(onTopic("What happened in the 1906 earthquake?", c("1513 Marash earthquake", "The 1513 Marash earthquake affected Marash."))).toBe(false);
  });
  it("temperature conversions are exact", () => {
    expect(temperatureConversion("What is 30 °C in Fahrenheit?", false)).toBe("30 °C = 86 °F (°F = °C × 9/5 + 32).");
    expect(temperatureConversion("Quanto é 100 °F em Celsius?", true)).toBe("100 °F = 37,8 °C (°C = (°F − 32) × 5/9).");
    expect(temperatureConversion("Convert -40 degrees Celsius to Fahrenheit", false)).toBe("-40 °C = -40 °F (°F = °C × 9/5 + 32).");
    expect(temperatureConversion("What is the capital of France?", false)).toBeNull();
    expect(temperatureConversion("Why is 30 °C hot?", false)).toBeNull();
  });
});

describe("onTopic: the article's own title (Sextant RF-1, plate boundaries)", () => {
  const c = (title: string, body: string) => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" as const });
  it("gate ea21e82 s32: a title that merely contains a question word is not on topic", () => {
    expect(onTopic("What causes the northern lights?", c("United States Northern Command", "USNORTHCOM is a unified combatant command of the U.S. Department of Defense."))).toBe(false);
    expect(onTopic("What is the tragedy of the commons?", c("Black Down and Sampford Common", "Black Down and Sampford Common is a Site of Special Scientific Interest in Somerset."))).toBe(false);
    expect(onTopic("What is the smallest country in South America by area?", c("Autonomy South", "Autonomy South is a political party."))).toBe(false);
  });

  it("'Plate tectonics' for plate boundaries; a subtitle word still needs coverage", () => {
    const plates = c("Plate tectonics", "Plate tectonics is the scientific theory that Earth's lithosphere comprises a number of large tectonic plates.");
    expect(onTopic("Why do earthquakes happen near plate boundaries?", plates)).toBe(true);
    expect(onTopic("earthquake plate tectonics plate boundary", plates)).toBe(true);
    expect(onTopic("What is the latest theory about dark matter?", c("Scary Stories: Dark Web", "Scary Stories: Dark Web is a 2020 supernatural horror anthology."))).toBe(false);
    expect(onTopic("What happened in the 1906 earthquake?", c("1513 Marash earthquake", "The 1513 Marash earthquake affected Marash in 1513."))).toBe(false);
    expect(onTopic("Who won the 1970 World Cup?", c("Andy Roberts (cricketer)", "He won the 1975 Cricket World Cup."))).toBe(false);
  });
});

describe("nosebleed core procedure includes direct pressure (RF-1, pt4)", () => {
  it("'Most anterior nosebleeds can be stopped by applying direct pressure' beats 'Nasal packing'", () => {
    const c = (id: string, body: string) => ({ chunkId: id, docId: id, title: "Nosebleed", body, score: 1, matchType: "lexical" as const, action: true });
    const sources = [
      c("pack", "Treatment > Nasal packing: Traditionally, nasal packing was accomplished by packing gauze into the nose. It is done by a clinician."),
      c("press", "Treatment: Most anterior nosebleeds can be stopped by applying direct pressure, which helps by promoting blood clots."),
    ];
    const topic = healthTopicTerms("Como estancar um sangramento nasal?", "nosebleed nose bleed");
    expect(healthSourceIndex(sources, coreProcedure(topic))).toBe(1);
    const epistaxis = { ...c("ep", "External wound management > Pressure points > Epistaxis: The appropriate point here is on the soft fleshy part of the nose, which should constrict the capillaries sufficiently to stop bleeding."), title: "Emergency bleeding control" };
    expect(healthSourceIndex([sources[0], epistaxis], coreProcedure(topic))).toBe(1);
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

describe("onTopic: a title's acronym", () => {
  it("'Maximal extractable value (MEV)' for a question naming MEV", () => {
    const c = { chunkId: "m", docId: "m", title: "ethereum.org: Maximal extractable value (MEV)", body: "Maximal extractable value refers to the maximum value that can be extracted from block production.", score: 1, matchType: "lexical" as const };
    expect(onTopic("O que é MEV e o que é a separação entre proponente e construtor?", c)).toBe(true);
    expect(onTopic("What is the minimum wage?", c)).toBe(false);
  });
});

describe("onTopic: two consecutive question terms (Sextant cmp-009)", () => {
  const c = (title: string, body: string) => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" as const });
  const q = "How did government in the Roman Republic differ from the Roman Empire?";
  it("keeps the Western Roman Empire and the Byzantine Empire", () => {
    expect(onTopic(q, c("Fall of the Western Roman Empire", "The fall of the Western Roman Empire was the loss of central political control in the Western Roman Empire."))).toBe(true);
    expect(onTopic(q, c("Byzantine Empire", "The Byzantine Empire, also known as the Eastern Roman Empire, was the continuation of the Roman Empire centred on Constantinople."))).toBe(true);
    expect(onTopic(q, c("Politics of Djibouti", "Politics of Djibouti takes place in a framework of a semi-presidential republic."))).toBe(false);
  });
  it("a pair that is only a place is not the subject (the consulate in Chiang Mai)", () => {
    const consulate = c("Consulate-General of China, Chiang Mai", "The Consulate-General of the People's Republic of China in Chiang Mai is the diplomatic mission of China to Chiang Mai and Northern Thailand.");
    expect(onTopic("When is the best time to visit Chiang Mai, and when is the smoky season?", consulate)).toBe(false);
  });
  it("does not reopen Scary Stories, Marash, Northern Command or Sampford Common", () => {
    expect(onTopic("What is the latest theory about dark matter?", c("Scary Stories: Dark Web", "Scary Stories: Dark Web is a 2020 supernatural horror anthology about the dark web."))).toBe(false);
    expect(onTopic("What happened in the 1906 earthquake?", c("1513 Marash earthquake", "The 1513 Marash earthquake affected Marash in 1513."))).toBe(false);
    expect(onTopic("What causes the northern lights?", c("United States Northern Command", "USNORTHCOM is a unified combatant command of the U.S. Department of Defense."))).toBe(false);
    expect(onTopic("What is the tragedy of the commons?", c("Black Down and Sampford Common", "Black Down and Sampford Common is a Site of Special Scientific Interest in Somerset."))).toBe(false);
  });
});

describe("passageLanguage / sourceLanguageLead", () => {
  it("reads the passage's function words", () => {
    expect(passageLanguage("A monsoon is traditionally a seasonal reversing wind.")).toBe("en");
    expect(passageLanguage("A monção é um vento sazonal que muda de direção.")).toBe("pt");
    expect(passageLanguage("EIP-1559")).toBeNull();
    expect(sourceLanguageLead(true, "The Earth's axis is tilted.")).toBe("Da fonte offline (em inglês):");
    expect(sourceLanguageLead(true, "A monção é um vento sazonal.")).toBeNull();
    expect(sourceLanguageLead(false, "The Earth's axis is tilted.")).toBeNull();
    expect(sourceLanguageLead(false, "A monção é um vento sazonal que muda de direção.")).toBe("From the offline source (in Portuguese):");
  });
});

describe("identifiersIn / compressContext pinned", () => {
  it("normalizes identifiers", () => {
    expect(identifiersIn("O que a EIP-7702 e o ERC 4337 fazem? BIP-32 também.")).toEqual(["EIP-7702", "ERC-4337", "BIP-32"]);
  });
  it("a pinned chunk is kept first even when the others out-score it", () => {
    const c = (id: string, title: string, body: string) => ({ chunkId: id, docId: id, title, body, score: 1, matchType: "lexical" as const });
    const eth = c("e", "Ethereum", "Ethereum is a blockchain. Ethereum has smart contracts. Ethereum uses ether.");
    const eip = c("p", "EIP-7251: Increase the MAX_EFFECTIVE_BALANCE", "Increases the constant to 2048 ETH.");
    const free = compressContext("Ethereum", [eth, eip]).chunks.map((x) => x.chunkId);
    expect(free).toEqual(["e"]);
    const pinned = compressContext("Ethereum", [eth, eip], { pinned: new Set(["p"]) }).chunks.map((x) => x.chunkId);
    expect(pinned).toEqual(["p", "e"]);
  });
});

describe("Sextant cry-020 / cry-012: content, not pointers or metadata", () => {
  const c = (title: string, body: string) => ({ chunkId: title + body.length, docId: title, title, body, score: 1, matchType: "lexical" as const });
  it("instantFinalBlock: a pointer, or a sentence that covers only the identifier, is not final", () => {
    expect(instantFinalBlock("O que mudou no Ethereum com o Merge (EIP-3675)?", "Full specification of the beacon chain can be found in the `ethereum/consensus-specs` repository.", "Ethereum EIP-3675")).toBe("pointer");
    expect(instantFinalBlock("What does EIP-3675 upgrade?", "The transition happens at the terminal total difficulty.", "Ethereum upgrade EIP-3675")).toBe("title-only");
    expect(instantFinalBlock("What is the capital of Australia?", "Canberra is the capital city of Australia.")).toBeNull();
  });
  it("isSubstantive: metadata, hex examples, copyright and stubs are not content", () => {
    expect(isSubstantive(c("EIP-155: Simple replay attack protection", "Status: Final Type: Standards Track (Core) Created: 2016-10-14"))).toBe(false);
    expect(isSubstantive(c("EIP-155: Simple replay attack protection", "Example: ``` 0xf86c098504a817c800825208943535353535 ```"))).toBe(false);
    expect(isSubstantive(c("EIP-155: Simple replay attack protection", "Hard fork: Spurious Dragon"))).toBe(false);
    expect(isSubstantive(c("ERC-2400: Transaction Receipt URI", "Copyright: Copyright and related rights waived via CC0."))).toBe(false);
    expect(isSubstantive(c("EIP-155: Simple replay attack protection", "Parameters: - FORK_BLKNUM: 2,675,000 - CHAIN_ID: 1 (main net)"))).toBe(true);
    expect(isSubstantive(c("Canberra", "Canberra is the capital city of Australia."))).toBe(true);
  });
});

describe("falseQuantumClaims (gate 394bf31, crypto-named-001 seed 5)", () => {
  it("catches classical public-key crypto called quantum resistant", () => {
    const seed5 = "Quantum-resistant signature algorithms include those based on elliptic curve cryptography (ECC) or lattice-based cryptography, such as those in the Open Quantum Safe (OQS) project.";
    expect(falseQuantumClaims(seed5)).toEqual([seed5]);
    expect(falseQuantumClaims("RSA and ECDSA are secure against quantum computers.")).toHaveLength(1);
    expect(falseQuantumClaims("Criptografia de curvas elípticas é resistente a computadores quânticos.")).toHaveLength(1);
  });
  it("leaves true or contrasting sentences alone", () => {
    for (const ok of [
      "RSA and ECC are not quantum resistant: Shor's algorithm breaks them.",
      "Unlike ECDSA, lattice-based signatures such as Dilithium are quantum resistant.",
      "Ethereum uses ECDSA today, while post-quantum signatures are being researched.",
      "ECC is vulnerable to quantum computers.",
      "Lattice-based and hash-based signatures are quantum resistant.",
      "RSA é amplamente usado, mas não é resistente a computadores quânticos.",
      "Nenhum algoritmo de assinatura clássica, como RSA ou DSA, é intrinsecamente resistente a computadores quânticos.",
      "Breaking a 256-bit ECC key would require thousands of logical qubits, highlighting the need for migration to quantum-resistant schemes.",
    ]) expect(falseQuantumClaims(ok), ok).toEqual([]);
  });
});

describe("sentenceNamesSubject (Sextant q7)", () => {
  it("the sentence must name the subject its title shares with the question", () => {
    expect(sentenceNamesSubject("Greenhouse effect", "Greenhouse effect", "Surface heating can happen from an internal heat source or come from an external source, such as a host star.")).toBe(false);
    expect(sentenceNamesSubject("Greenhouse effect", "Greenhouse effect", "The greenhouse effect occurs when heat-trapping gases prevent the planet from losing heat.")).toBe(true);
    expect(sentenceNamesSubject("What is the capital of Australia?", "Canberra", "Canberra is the capital city of Australia.")).toBe(true);
  });
  it("cry-004-pt: an EIP page's sentence may name it by its title's name, not only its number", () => {
    const t = "Ethereum EIPs/ERCs: EIP-4844: Shard Blob Transactions";
    expect(sentenceNamesSubject("Ethereum EIP-4844", t, "Shard Blob Transactions scale data-availability of Ethereum in a simple, forwards-compatible manner.")).toBe(true);
    expect(sentenceNamesSubject("Ethereum EIP-4844", t, "Throughout this proposal we use cryptographic methods and classes defined in the corresponding consensus specs.")).toBe(false);
  });
});

describe("healthExtract: the quoted text's own instructions count as steps (Sextant dng-005-pt)", () => {
  it("a travel page's list of instructions is not introduced as 'no first-aid steps'", () => {
    const c = { chunkId: "w", docId: "w", title: "Wikivoyage: Water", body: "Buy: - Boil the water before drinking (several minutes) - Use iodine tablets (will kill bacteria) - Use a survival straw. Consider drinking tea or bottled juices instead of unsafe water.", score: 1, matchType: "lexical" as const, action: true };
    expect(imperativeSteps(c.body)).toBeGreaterThanOrEqual(2);
    const topic = healthTopicTerms("Depois de uma enchente, a água da torneira pode estar contaminada. Como deixo a água segura para beber?", "safe drinking water flood");
    const text = healthExtract(c, 1, true, coreProcedure(topic));
    expect(text).toMatch(/^Da fonte offline \(em inglês\):\n/);
    expect(text).not.toMatch(/não traz os passos/);
  });
});

describe("withAfterPart (Sextant dng-004-pt)", () => {
  const c = (id: string, body: string) => ({ chunkId: id, docId: id, title: "US government: Earthquakes (Ready.gov)", body, score: 1, matchType: "lexical" as const, action: true });
  const q = "Começou um terremoto e eu estou no quarto do hotel. O que eu faço, e o que fazer depois que parar?";
  const during = c("d", "During an Earthquake > Protect Yourself During Earthquakes: - 1. Drop (or Lock): Drop where you are onto hands and knees. - 2. Cover: Cover your head and neck. - 3. Hold On: Hold until the shaking stops.");
  const after = c("a", "After an Earthquake: Check yourself for injuries. Expect aftershocks. If you are in a damaged building, go outside and quickly move away from the building.");
  const topic = healthTopicTerms(q, "earthquake");
  const rules = { procedure: coreProcedure(topic) };
  it("quotes the 'After' section too, with its own [n], before the emergency line", () => {
    const first = healthExtract(during, 1, true, rules);
    const out = withAfterPart(q, first, [during, after], 0, true, rules);
    expect(out).toMatch(/Hold until the shaking stops\. \[1\]\n\nAfter an Earthquake: Check yourself for injuries\..*\[2\]\n\nEm uma emergência/s);
  });
  it("without an 'After' section, says the source covers only 'during'", () => {
    const out = withAfterPart(q, healthExtract(during, 1, true, rules), [during], 0, true, rules);
    expect(out).toMatch(/A fonte citada cobre o que fazer durante; não encontrei no acervo offline o que fazer depois\.\n\nEm uma emergência/);
  });
  it("a question without an 'after' part is unchanged", () => {
    const q1 = "O que fazer durante um terremoto?";
    const first = healthExtract(during, 1, true, rules);
    expect(withAfterPart(q1, first, [during, after], 0, true, rules)).toBe(first);
  });
});

describe("dng-005: making water safe, the excerpt stops before 'drink something else' (Sextant)", () => {
  it("keeps boil / iodine / straw, drops tea, milk, coffee and sea water", () => {
    const c = { chunkId: "w", docId: "w", title: "Wikivoyage: Water", body: "Buy: - Boil the water before drinking (several minutes, depending on what you want to kill) - Use iodine tablets (will kill bacteria, but make the water taste bad) - Use a survival straw (probably best for extremely remote areas) Consider drinking tea, soft drinks or bottled juices instead of unsafe water. Milk or yoghurt may also be OK. Coffee and alcoholic drinks will dehydrate you. Never drink sea water, even small amounts.", score: 1, matchType: "lexical" as const, action: true };
    const q = "Depois de uma enchente, a água da torneira pode estar contaminada. Como deixo a água segura para beber?";
    const topic = healthTopicTerms(q, "safe drinking water flood");
    const text = healthExtract(c, 1, true, excerptRules(q, topic));
    expect(text).toMatch(/Boil the water before drinking/);
    expect(text).toMatch(/Use iodine tablets/);
    expect(text).not.toMatch(/tea|Milk|Coffee|sea water/);
  });
});

describe("isPortugueseQuestion (trv-009 PT)", () => {
  it("PT without interrogatives; never a short English question", () => {
    expect(isPortugueseQuestion("É esperado dar gorjeta em restaurantes em Portugal?")).toBe(true);
    for (const q of ["How do I stop a nosebleed?", "Is tipping expected in restaurants in Portugal?", "What is a monsoon?", "Is São Paulo safe at night?", "Do I need a visa for Brazil?"]) expect(isPortugueseQuestion(q), q).toBe(false);
  });
});

describe("namedByLexicon: a '… by country' list item is not the subject (trv-009)", () => {
  const c = (title: string, body: string) => ({ chunkId: title, docId: title, title, body, score: 1, matchType: "lexical" as const });
  it("the country heading under a by-country list doesn't count; the country's own page does", () => {
    expect(namedByLexicon(["Portugal"], c("Triage", "Specific triage systems and methods > Triage systems by country > Portugal: In Portugal, the Manchester Triage System is used."))).toBe(false);
    expect(namedByLexicon(["Portugal"], c("Wikivoyage: Portugal", "Buy > Tipping: Tipping is not expected but appreciated."))).toBe(true);
  });
});

describe("stripModelDisclaimer (gate cd1478a: the notice twice)", () => {
  it("removes the model's own opening notice, EN and PT, as the gate saw it", () => {
    const cases: Array<[string, boolean, string]> = [
      ["This answer is not from an offline source. Brazil uses Type C plugs.", false, "Brazil uses Type C plugs."],
      ["Esta resposta não está em um banco de dados offline. Em Portugal, não é estritamente esperado dar gorjeta.", true, "Em Portugal, não é estritamente esperado dar gorjeta."],
      ["Essa resposta não está em uma fonte offline. Você pode ir de ônibus do aeroporto.", true, "Você pode ir de ônibus do aeroporto."],
      ["Esta resposta não vem de uma fonte offline. As estações do ano existem devido à inclinação do eixo.", true, "As estações do ano existem devido à inclinação do eixo."],
      ["Esta resposta não vem de uma fonte offline deste celular; confira antes de confiar nela.\n\nEsta resposta não está em um banco de dados offline. O ABS detecta a rotação das rodas.", true, "O ABS detecta a rotação das rodas."],
      ["I don't have a source for this. TCP is reliable; UDP is faster.", false, "TCP is reliable; UDP is faster."],
    ];
    for (const [input, pt, out] of cases) expect(stripModelDisclaimer(input, pt), input).toBe(out);
  });
  it("leaves an answer that doesn't open with a notice alone", () => {
    for (const t of ["The offline library is a feature of this app.", "Esta resposta depende do país.", "RSA is broken by quantum computers."]) expect(stripModelDisclaimer(t, false)).toBe(t);
  });
});

describe("stripModelReferences (CT-A: an invented reference at the end of a PT answer)", () => {
  it("removes the exact line the Rápido wrote", () => {
    const text = "As monções são ventos sazonais que trazem chuva ao sul da Ásia [1].\n\n[1] Monsoon, Wikipedia, acessado em 1 de fevereiro de 2023";
    expect(stripModelReferences(text)).toBe("As monções são ventos sazonais que trazem chuva ao sul da Ásia [1].");
  });
  it("removes reference sections and dated lines, EN and PT", () => {
    const cases: Array<[string, string]> = [
      ["Canberra is the capital [1].\n\nReferences:\n[1] Canberra, Wikipedia, retrieved on 3 March 2023\n[2] Hall Primary School, Wikipedia", "Canberra is the capital [1]."],
      ["O Brasil usa tomadas tipo N [1].\n\nFontes:\n- Plug, Wikipedia\n- https://example.org/plugs", "O Brasil usa tomadas tipo N [1]."],
      ["O Brasil usa tomadas tipo N [1].\n\n**Referências**\n1. Tomada, Wikipédia, acessado em 2 de março de 2024", "O Brasil usa tomadas tipo N [1]."],
      ["Mold needs moisture [2].\nFonte: Wikipedia", "Mold needs moisture [2]."],
      ["Mold needs moisture [2].\nRetrieved on 12 May 2022.", "Mold needs moisture [2]."],
      ["Mold needs moisture [2]. [3] Mold, Wikipedia, accessed on 1 June 2023", "Mold needs moisture [2]."],
      ["### Sources\n\n[1] Canberra, Wikipedia", ""],
    ];
    for (const [input, out] of cases) expect(stripModelReferences(input), input).toBe(out);
  });
  it("keeps the markers of a sources line that holds only [n]", () => {
    expect(stripModelReferences("Canberra is the capital of Australia.\n\nFontes: [1], [2]")).toBe("Canberra is the capital of Australia. [1][2]");
  });
  it("leaves answers without a reference list alone", () => {
    for (const t of [
      "Sources of vitamin C: oranges, lemons and peppers [1].",
      "1. Boil the water for one minute [1].\n2. Let it cool.",
      "The Wikipedia article is one of the offline sources [2].",
      "Fontes de ferro incluem feijão e lentilha [1].",
    ])
      expect(stripModelReferences(t), t).toBe(t);
  });
});

describe("wrongScriptSentences (Sextant trv-007-pt)", () => {
  it("Khmer given as Thai is caught; Thai given as Thai is not", () => {
    const q = "Como se diz obrigado em tailandês, e muda se eu for homem ou mulher?";
    expect(wrongScriptSentences(q, 'Obrigado em tailandês é "សួស្តី" (sàa-ssàa), e não muda com o sexo.')).toHaveLength(1);
    expect(wrongScriptSentences(q, 'Obrigado em tailandês é "ขอบคุณ" (khob khun); homens dizem "khrap" e mulheres "kha".')).toEqual([]);
    expect(wrongScriptSentences("How do I say hello in Japanese?", "Hello is こんにちは (konnichiwa).")).toEqual([]);
    expect(wrongScriptSentences("How do I say hello in Japanese?", "Hello is 안녕하세요.")).toHaveLength(1);
    expect(wrongScriptSentences("What is the capital of France?", "Paris (Париж in Russian).")).toEqual([]);
  });
});

describe("isHealthQuestion: health for the content, translation for the form (Sextant lng-009, gate 52a2310)", () => {
  it("a phrase to translate with health content stays health; a phrase without it does not", () => {
    expect(isHealthQuestion("How do I say 'I am allergic to peanuts' in French?")).toBe(true);
    expect(isHealthQuestion("How do I say I am allergic to peanuts in French?")).toBe(true);
    expect(isHealthQuestion("Como se diz 'sou alérgico a amendoim' em francês?")).toBe(true);
    expect(isHealthQuestion("How do I say 'I need my insulin' in Spanish?")).toBe(true);
    expect(isHealthQuestion("What do I do if I'm allergic to peanuts?")).toBe(true);
    expect(isHealthQuestion("How do I greet someone politely in Korean?")).toBe(false);
    expect(isHealthQuestion("What is the difference between 'tu' and 'vous' in French?")).toBe(false);
    expect(isHealthQuestion("Which direction is Arabic written in, and how do you say hello in Arabic?")).toBe(false);
    expect(isHealthQuestion("How do I say thank you in Thai, and does it change if I'm a man or a woman?")).toBe(false);
    expect(isHealthQuestion("Como se diz obrigado em tailandês, e muda se eu for homem ou mulher?")).toBe(false);
  });
});
