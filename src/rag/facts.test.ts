import { describe, it, expect } from "vitest";
import { factsAnswer, factEntities, factTemplates } from "./facts";

const text = (q: string) => factsAnswer(q)?.text ?? null;

describe("FACTS: the step-1 target items (bench v0.1, dev)", () => {
  it("lan-cmp-001: two-country population comparison → computed yes/no verdict", () => {
    const a = factsAnswer("Does Brazil have more people than Russia?")!;
    expect(a.template).toBe("population");
    expect(a.text).toMatch(/^Yes\. Brazil has more people than Russia: Brazil 21\d\.\d million \(20\d\d\) vs Russia 14\d\.\d million/);
    expect(text("Does Russia have more people than Brazil?")).toMatch(/^No\. Brazil has more people than Russia/);
    expect(text("Does Russia have fewer people than Brazil?")).toMatch(/^Yes\./);
  });
  it("lan-rsn-002: a building's height against a lake's depth", () => {
    expect(text("If you stood the Burj Khalifa on the deepest point of Lake Baikal, would its top stick out of the water?")).toMatch(
      /^No\. Burj Khalifa is 828 m tall; Lake Baikal is 1,642 m deep at its deepest point, so its top would be about 814 m below the surface/,
    );
  });
  it("lan-ref-001 / lan-ref-005: award winner by year, host city", () => {
    expect(text("Who received the Nobel Prize in Literature in 2017?")).toMatch(/2017: Kazuo Ishiguro\./);
    expect(text("Who received the Nobel Prize in Literature?")).toBeNull(); // no year → no fire
    expect(text("Which city hosted the 2016 Summer Olympics?")).toMatch(/held in Rio de Janeiro/);
  });
  it("lan-ref-004 / lan-exp-006 / lan-rsn-007: area, elevation (+ type, country), dates", () => {
    expect(text("How big is Iceland in square kilometres?")).toMatch(/^Iceland \(.*\): area 103,004 km²/);
    expect(text("What is Kilimanjaro, how high is it, and is it a volcano?")).toMatch(/Tanzania; type: dormant volcano.*elevation 5,895 m/);
    expect(text("In which year was the Berlin Wall built, and in which year did it come down?")).toMatch(/13 August 1961.*9 November 1989/);
  });
  it("trv-002: plugs and voltage are one template (electricity)", () => {
    expect(text("What plug type and voltage does Brazil use?")).toMatch(/Type C .*Type N .*127 V \/ 220 V/);
  });
  it("every answer carries the source line", () => {
    expect(text("What is the capital of Kenya?")).toMatch(/The capital of Kenya is Nairobi\.\n\nFrom Wikidata \(CC0\), offline table as of 2026-10-06\./);
  });
});

describe("FACTS: the trigger stays narrow", () => {
  it("no fire on multi-slot overviews (≥ 2 templates) or explanation wording", () => {
    expect(factsAnswer("What are the key facts about Montenegro: capital, currency, coastline and how it became independent?")).toBeNull();
    expect(factsAnswer("Give me the essentials on Kenya: its location, capital, official languages and year of independence.")).toBeNull();
    expect(factsAnswer("Give me a quick overview of Singapore: where it is, how it became independent, and what languages people speak there.")).toBeNull();
    expect(factsAnswer("Describe Greenland: who governs it, its capital, roughly how many people live there, and how much of it is covered by ice.")).toBeNull();
    expect(factsAnswer("Tell me about Japan")).toBeNull();
    expect(factTemplates("What is the capital and currency of Peru?")).toEqual(["capital", "currency"]);
    expect(factsAnswer("What is the capital and currency of Peru?")).toBeNull();
  });
  it("no fire on unsupported slots, set queries or an entity without the value", () => {
    expect(factsAnswer("Which is more densely populated, Japan or Germany, and by how much?")).toBeNull();
    expect(factsAnswer("Which countries are bigger than India by area?")).toBeNull();
    expect(factsAnswer("How long is the Great Wall of China, and can you really see it from the Moon?")).toBeNull();
    expect(factsAnswer("What is the capital of Lake Baikal?")).toBeNull();
    expect(factsAnswer("What is the population of Atlantis?")).toBeNull();
  });
  it("no fire on health, danger or non-questions", () => {
    expect(factsAnswer("I'm at 4,000 m in the Andes with a headache and nausea. What should I do?")).toBeNull();
    expect(factsAnswer("Is it safe to go to La Paz with the altitude?")).toBeNull();
    expect(factsAnswer("I love the capital of France")).toBeNull();
  });
  it("entities: longest name first, inner words never resolve twice; lone words must be capitalized", () => {
    expect(factEntities("When was the Berlin Wall built?").map((e) => e.n)).toEqual(["Berlin Wall"]);
    expect(factEntities("what is the population of turkey?")).toEqual([]); // r3: risk-list word, lowercase never resolves
    expect(factEntities("Which is longer, the Nile or the Amazon River?").length).toBeGreaterThanOrEqual(1);
  });
  it("comparison needs two entities with the value; a 'which' question gets the verdict without yes/no", () => {
    expect(text("Which has more people, Brazil or Russia?")).toMatch(/^Brazil has more people than Russia/);
    expect(text("Is Iceland bigger than Brazil?")).toMatch(/^No\. Brazil is larger by area than Iceland/); // r3: "bigger than" → area
  });
  it("lookup is fast (warm)", () => {
    factsAnswer("How big is Iceland in square kilometres?");
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) factsAnswer("Does Brazil have more people than Russia?");
    expect((performance.now() - t0) / 200).toBeLessThan(5);
  });
});

describe("FACTS r2: data and trigger gates (DATA-REVIEW.md §4)", () => {
  it("gate 1: no founding year for countries; the Berlin Wall keeps its dates", () => {
    expect(factsAnswer("When was Italy founded?")).toBeNull();
    expect(factsAnswer("When was the United States founded?")).toBeNull();
    expect(text("In which year was the Berlin Wall built, and in which year did it come down?")).toMatch(/13 August 1961/);
  });
  it("gate 2: population only when dated >= 2020", () => {
    expect(factsAnswer("What is the population of the Netherlands?")).toBeNull(); // latest statement 2013
    expect(text("What is the population of Iceland?")).toMatch(/\((dated )?20(2\d)\)/);
  });
  it("gate 3: no former/unbuilt entities, no out-of-range values, no answer for a name with two entities", () => {
    expect(factsAnswer("How long is the Bian River?")).toBeNull();
    expect(factsAnswer("How tall is X-Seed 4000?")).toBeNull();
    expect(factsAnswer("How big is Lake Agassiz?")).toBeNull();
    expect(factsAnswer("What is the population of Bandung?")).toBeNull(); // city and regency share the label
    expect(factsAnswer("What is the capital of Georgia?")).toBeNull(); // the US state is not in the table
  });
  it("gate 4: nickname aliases removed; every word of a name must be typed capitalised", () => {
    expect(factsAnswer("How tall is the White House?")).toBeNull();
    expect(factsAnswer("How big is Michigan?")).toBeNull();
    expect(factsAnswer("How high is the Cape?")).toBeNull();
    expect(factsAnswer("How long is the Green River?")).toBeNull();
    expect(factsAnswer("How many people live in Garden City?")).toBeNull();
    expect(factsAnswer("How tall is Trump Tower?")).toBeNull();
    // r4 rule 1 (kept in r5 rule D): a lowercase multi-word name that names exactly one entity resolves.
    expect(factEntities("how deep is lake baikal?").map((e) => e.n)).toEqual(["Lake Baikal"]);
    expect(factEntities("How deep is Lake Baikal?").map((e) => e.n)).toEqual(["Lake Baikal"]);
  });
});

describe("FACTS r3: trigger recall fixes (FACTS-RECALL.md)", () => {
  it("fix 1: one-word country/capital names may be typed lowercase; risk words and multi-word names may not", () => {
    expect(text("what is the population of canada")).toMatch(/^Canada \(.*\): population 40 million/);
    expect(text("what is the official language of egypt")).toMatch(/Official language of Egypt: Arabic/);
    expect(text("what continent is peru on")).toMatch(/^Peru is in South America/);
    expect(factEntities("how big is paris").map((e) => e.n)).toEqual(["Paris"]);
    for (const w of ["georgia", "turkey", "chad", "jordan", "china", "america"])
      expect(factsAnswer(`what is the population of ${w}`)).toBeNull();
    expect(factsAnswer("how tall is jordan")).toBeNull();
    expect(factsAnswer("how long is the amazon river")?.entities).toEqual(["Q3783"]); // r4/r5 rule D: one exact label
    expect(factsAnswer("how tall is kilimanjaro")).toBeNull(); // a mountain, not a country or capital
    expect(factsAnswer("what is the population of south sudan")).toBeNull(); // not Sudan
    expect(factsAnswer("what is the population of mexico city")?.text).toMatch(/^Mexico City \(/); // r4/r5 rule D; not Mexico
    expect(factsAnswer("what is the population of new mexico")).toBeNull();
  });
  it("fix 2: aliases China, UK/U.K./the UK/Britain, US/U.S./USA/America, the Amazon", () => {
    expect(factEntities("What is the population of China?").map((e) => e.q)).toEqual(["Q148"]);
    for (const q of ["What currency does the UK use?", "what currency does the uk use", "What is the capital of the U.K.?", "How big is Britain?"])
      expect(factsAnswer(q)?.entities).toEqual(["Q145"]);
    for (const q of ["What currency does the US use?", "How big is the U.S.?", "What is the population of the USA?", "How big is America?"])
      expect(factsAnswer(q)?.entities).toEqual(["Q30"]);
    expect(factsAnswer("what is the population of the us")).toBeNull(); // lowercase "us" is a pronoun
    expect(text("Which is longer, the Nile or the Amazon?")).toMatch(/^Nile is longer than Amazon River/);
    expect(factsAnswer("How big is Amazon?")).toBeNull(); // the company: only "the Amazon" is the river
  });
  it("fix 3: size of / how big / bigger, larger, smaller than / which is bigger → area", () => {
    expect(text("what's the size of brazil")).toMatch(/^Brazil \(.*\): area 8,515,767 km²/);
    expect(text("Which is bigger, Canada or the United States?")).toMatch(/^Canada is larger by area than United States: Canada 9,984,670 km² .* vs United States 9,826,675 km²/);
    expect(text("Is Iceland smaller than Brazil?")).toMatch(/^Yes\. Brazil is larger by area than Iceland/);
    expect(factTemplates("Which is larger, Peru or Chile?")).toEqual(["area"]);
    expect(factTemplates("Is Brazil's population larger than Russia's?")).toEqual(["population"]); // a named property wins
  });
  it("fix 4: a name glued to an unknown capitalised word, or a compound property word, does not fire", () => {
    expect(factsAnswer("How tall is Paris Hilton?")).toBeNull();
    expect(factsAnswer("When was the Paris Agreement signed?")).toBeNull();
    expect(factsAnswer("How tall is the London Eye?")).toBeNull();
    expect(factsAnswer("How tall is Michael Jordan?")).toBeNull();
    expect(factsAnswer("How big is South America?")).toBeNull();
    // r6: Lake Chad is now a table lake (asset coverage); the glued name answers for the lake, never the country Chad.
    expect(factsAnswer("How big is Lake Chad?")?.entities).toEqual(["Q125309"]);
    expect(factsAnswer("What is the area code for London?")).toBeNull();
    expect(factTemplates("What is your area of expertise?")).toEqual([]);
    expect(text("What Is The Population Of France?")).toMatch(/^France \(.*\): population/); // title case still fires
    expect(text("How long is the Danube River?")).toMatch(/^Danube \(.*\): length 2,850 km/); // feature word of the same kind
  });
  it("fix 5: a population dated before 2023 prints (dated YEAR); 2023+ prints (YEAR)", () => {
    expect(text("How many people live in Nigeria?")).toMatch(/population 211\.4 million \(dated 2021\)\./);
    expect(text("What is the population of Canada?")).toMatch(/population 40 million \(2023\)\./);
  });
});

describe("FACTS r5: two-sided neighbour guard, question openers, whole-label override (FACTS-r5-criterion.md)", () => {
  it("rule A: a lowercase content word on either side of a name → no fire", () => {
    for (const q of [
      "how tall is paris hilton", "how tall is a mont blanc pen", "how big is a cuba libre", "how big is a london broil",
      "how tall is mount everest base camp", "how tall is the paris las vegas eiffel tower", "how high is the mexico city metro fare",
      "how long is the rio grande valley", "how tall is the berlin wall memorial", "what language is the japan times written in",
      "how many people live in jersey city", "what is the population of new england",
    ])
      expect(factsAnswer(q), q).toBeNull();
  });
  it("rule A: question, property, hedge, unit and comparison words, and another resolved name, are allowed neighbours", () => {
    expect(factsAnswer("how tall is mount everest")?.entities).toEqual(["Q513"]);
    expect(text("how tall is mount everest in feet")).toMatch(/^Mount Everest \(/);
    expect(text("how tall is the kuala lumpur tower")).toMatch(/^Kuala Lumpur Tower \(.*\): height 421 m/); // the whole label
    expect(text("roughly how many people live in canada today?")).toMatch(/^Canada \(.*\): population 40 million/);
    expect(text("What's the capital city of Ethiopia?")).toMatch(/^The capital of Ethiopia is Addis Ababa/); // "capital city"
    expect(text("Is Chad bigger than Jordan by area?")).toMatch(/^Yes\. Chad is larger by area than Jordan/);
    expect(text("how long is the danube river")).toMatch(/^Danube \(/); // r3 feature-word exception, any casing
  });
  it("rule A: a capitalised content word is checked too, on both sides and across punctuation", () => {
    expect(factsAnswer("How tall is Paris Hilton?")).toBeNull();
    expect(factsAnswer("Which language is spoken in Swiss schools?")).toBeNull();
    expect(factsAnswer("What is the population of Paris, the city of light?")).toBeNull(); // "city" is not part of the label
    expect(factsAnswer("How big is Greater London?")).toBeNull();
  });
  it("rule B: whats/hows/wheres and size/capital/population/elevation/height/length of … are questions without ?", () => {
    expect(text("whats the capital of the philippines")).toMatch(/^The capital of Philippines is Manila/);
    expect(text("capital of new zealand")).toMatch(/Wellington/);
    expect(text("population of japan")).toMatch(/^Japan \(.*\): population/);
    expect(factsAnswer("the capital of japan")).toBeNull(); // no opener, no "?"
  });
  it("rule C: a whole multi-word label resolves even with a risk-list word; a lone risk word still does not", () => {
    expect(text("how big is lake victoria")).toMatch(/^Lake Victoria \(.*\): area 68,100 km²/);
    expect(factsAnswer("how big is victoria")).toBeNull();
    expect(factsAnswer("what is the population of georgia")).toBeNull();
  });
  it("rule D (r4 kept): safe lowercase multi-word names; typo-tolerant the", () => {
    expect(text("how high is mont blanc")).toMatch(/^Mont Blanc \(.*\): elevation 4,806 m/);
    expect(factsAnswer("how high are the petronas towers")).not.toBeNull();
    expect(text("what is the capital of thw Netherlands?")).toMatch(/is Amsterdam/);
  });
});

describe("FACTS r6: five trigger fixes (FACTS-r6-criterion.md B)", () => {
  it("fix 1: opener typos whta/waht/wat → what, hwo → how, whats' → whats", () => {
    expect(text("waht is the capital of Chile")).toMatch(/^The capital of Chile is Santiago/);
    expect(factsAnswer("waht is the capital of chile")).toBeNull(); // lowercase "chile" stays on the r3 risk list
    expect(text("whta is the population of Canada?")).toMatch(/^Canada \(.*\): population/);
    expect(text("wat is the area of france")).toMatch(/^France \(.*\): area 643,801 km²/);
    expect(text("hwo tall is the burj khalifa")).toMatch(/^Burj Khalifa \(.*\): height 828 m/);
    expect(text("whats' the capital of peru")).toMatch(/^The capital of Peru is Lima/);
    expect(factsAnswer("Wat Arun is a temple")).toBeNull(); // only the opening word of a question frame
  });
  it("fix 2: official language(s) of X / continent of X without what or ?", () => {
    expect(text("official language of brazil")).toMatch(/^Official languages of Brazil: .*Portuguese/);
    expect(text("official languages of switzerland")).toMatch(/French, German, Italian and Romansh/);
    expect(text("continent of kenya")).toMatch(/^Kenya is in Africa\./);
    expect(factsAnswer("language of brazil")).toBeNull(); // not one of the listed openers
  });
  it("fix 3: what/which continent is <place> in/on → its one country's continent", () => {
    expect(text("which continent is Addis Ababa in?")).toMatch(/^Addis Ababa is in Ethiopia, which is in Africa\./);
    expect(text("what continent is nairobi on")).toMatch(/^Nairobi is in Kenya, which is in Africa\./);
    expect(factsAnswer("What continent is Paris on?")).toBeNull(); // France spans several continents (overseas regions)
  });
  it("fix 4: what country/countries surround(s) X asks for borders", () => {
    expect(text("what countries surround iran?")).toMatch(/^Iran borders Afghanistan, .*Turkmenistan/);
    expect(text("What country surrounds Lesotho")).toMatch(/^Lesotho borders South Africa\./);
  });
  it("fix 5: which is taller/higher, X or Y / is X taller/higher than Y, two mountains or two structures, any casing", () => {
    expect(text("which is higher, aconcagua or kilimanjaro")).toMatch(/^Aconcagua is taller than Mount Kilimanjaro: Aconcagua 6,962 m/);
    expect(text("is aconcagua higher than k2?")).toMatch(/^No\. K2 is taller than Aconcagua/);
    expect(text("is the eiffel tower taller than the cn tower?")).toMatch(/^No\. CN Tower is taller than Eiffel Tower/);
    expect(text("which is taller, the empire state building or the chrysler building?")).toMatch(/^Empire State Building is taller than Chrysler Building/);
    expect(factsAnswer("which is higher, aconcagua or the burj khalifa")).toBeNull(); // a mountain and a building
    expect(factsAnswer("which is taller, everest base camp or k2")).toBeNull(); // a side that is not one whole name
    expect(factsAnswer("Which is taller, K2 or Everest?")).toBeNull(); // "Everest" alone is not a label/alias (no hand aliases)
  });
});

describe("FACTS asset r7: labels and currencies (native app report, 2026-10-18)", () => {
  const text = (q: string) => factsAnswer(q)?.text ?? null;
  it("fills labels the snapshot returned as bare QIDs", () => {
    expect(text("What currency does Germany use?")).toMatch(/^Germany's currency: euro\./);
    expect(text("Who won the Nobel Prize in Literature in 1907?")).toMatch(/1907: Rudyard Kipling\./);
  });
  it("drops ended, never-issued and Caribbean-only tenders, and leaves an unclear case to the model", () => {
    expect(text("What is the currency of El Salvador?")).toMatch(/^El Salvador's currency: United States dollar\./);
    expect(text("What currency do they use in the Netherlands?")).toMatch(/currency: euro\./);
    expect(text("What currency does Zimbabwe use?")).toBeNull();
  });
});

describe("FACTS asset r8: emergency numbers and snapshot-year population fix (2026-10-19)", () => {
  const text = (q: string) => factsAnswer(q)?.text ?? null;
  it("answers a country's emergency numbers with their service", () => {
    expect(text("What is the emergency number in Thailand?")).toMatch(/^Emergency numbers in Thailand: police 191, fire department 199 and emergency medical services 1669\./);
    expect(text("What is the police number in Japan?")).toMatch(/police 110/);
    expect(text("Is there an emergency exit in the Burj Khalifa?")).toBeNull();
  });
  it("drops round snapshot-year population figures and fixes misleading areas", () => {
    expect(text("What is the population of Tunisia?")).toMatch(/population 12 million \(2024\)/);
    expect(text("How big is Denmark?")).toMatch(/area 42,933 km²/);
    expect(text("How big is Yemen?")).toMatch(/area 527,968 km²/);
  });
});

describe("FACTS desktop: possessive names", () => {
  it("reads Japan's as Japan, for one value and a comparison", () => {
    expect(text("What is Japan's population in 2025?")).toMatch(/^Japan \(.*\): population [\d.]+ million \(\d{4}\)\.\n\nFrom Wikidata/);
    expect(text("is Japan's population larger than Nigeria's?")).toMatch(/^No\. Nigeria has more people than Japan/);
    expect(text("What's France's capital?")).toMatch(/^The capital of France is Paris\./);
  });
});
