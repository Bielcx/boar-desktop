import { describe, expect, it } from "vitest";
import { coHazardAnswer, coHazardLanguage, isCoHazardQuestion } from "./coHazard";

describe("isCoHazardQuestion (EN)", () => {
  it("fires on a fuel-burning device in an enclosed or attached space", () => {
    for (const q of [
      "Can I run my portable generator in the attached garage if I keep the door open?",
      "is it ok to use a charcoal grill inside the tent if it's raining",
      "We're camping and it's freezing. Can we bring the propane heater into the camper overnight?",
      "Can I use my Mr. Heater in the basement while I work?",
      "Is it safe to use a camping stove inside the tent to cook?",
      "Power's out. Can I run the generator in the basement with a window cracked?",
      "Can I warm up my car in the garage with the door closed for a few minutes?",
      "Is it safe to use the gas oven to heat the apartment during the outage?",
      "Can I use a disposable bbq in my tent if I leave the flap open?",
      "Can we run a kerosene heater in our ice fishing shack?",
      "I have a generator. Can I keep it running in the shed during the storm?",
      "Can I put the generator in the carport?",
      "Running a pressure washer in an enclosed porch, is that ok?",
    ])
      expect(isCoHazardQuestion(q), q).toBe(true);
  });

  it("stays out of symptoms, alarms, electric devices, figurative and non-space mentions", () => {
    for (const q of [
      "We ran the generator in the garage and now we all have headaches",
      "The CO alarm is beeping in the basement, what do I do?",
      "Can I use an electric heater in the tent?",
      "Can I use my grill in the apartment?",
      "Write a random number generator inside a function in Python",
      "Best charcoal drawing techniques indoors",
      "How many watts does a generator need to run a fridge?",
      "What is a static site generator?",
      "Where can I buy activated charcoal inside the airport?",
      "Is it safe to run a portable generator in the rain?",
      "Garage sale tips: how do I price an old generator?",
      "How do I cook rice on a gas stove?",
      "Is it safe to sleep in a tent in bear country?",
    ])
      expect(isCoHazardQuestion(q), q).toBe(false);
  });
});

describe("reviewer C1/C2 (2026-10-03)", () => {
  it("installed or vented appliances and a propane kitchen range do not fire; a vented generator still does", () => {
    for (const q of [
      "Is it safe to have a gas water heater in the basement?",
      "Is it safe to have a gas water heater in the garage?",
      "Can I use my vented gas heater in the living room?",
      "Is it safe to cook on my propane stove in the kitchen?",
    ])
      expect(isCoHazardQuestion(q), q).toBe(false);
    expect(isCoHazardQuestion("Can I run the generator in the basement if it's vented?")).toBe(true);
  });

  it("never leads with No. on risk questions, alternatives or safe setups", () => {
    for (const q of [
      "Is it safe to run my generator outside 25 ft from the house?",
      "Is it safe to run my generator 6 m from the window?",
      "Can you die from running a generator in the garage?",
      "Can you get CO poisoning from a camping stove in a tent?",
      "Could we get poisoned if we run the generator in the basement?",
      "Is it dangerous to run a generator in the garage?",
      "Is it bad to run a generator in the garage?",
      "Should we move the generator out of the garage?",
      "Should I be concerned about running the generator in the garage overnight?",
      "Should I worry about running the generator in the garage?",
      "Can I keep the generator outside instead of in the garage?",
      "Should I run the generator outside or in the garage?",
      "Can I use my camping stove outside the tent?",
      "Is it ok to move the camping stove out of the tent?",
      "Is it safe to run my generator in the driveway, 25 feet from the garage?",
      "Can I run my generator 30 feet from the garage door?",
      "Is it safe to have a gas water heater in the basement?",
      "Can I use my vented gas heater in the living room?",
      "Is it safe to cook on my propane stove in the kitchen?",
    ])
      // Production property: the answer is only shown when the trigger fires; then it must not start with "No.".
      expect(isCoHazardQuestion(q) && /^No\./.test(coHazardAnswer(q)), q).toBe(false);
    expect(coHazardAnswer("Can I run my portable generator in the attached garage if I keep the door open?")).toMatch(/^No\. Carbon monoxide/);
  });
});

describe("follow-up: appliance names in passing, propane stoves outside the kitchen", () => {
  it("an installed appliance named in passing no longer vetoes; a kitchen range (home or RV) still does not fire", () => {
    for (const q of [
      "we're boondocking in an old class C, how do I safely use the propain catalytic heater while we sleep? the furnace eats the battery",
      "can I cook on my butane stove inside the van with the sliding door shut when its raining",
      "doin a crawfish boil and it's stormin, can we run the propane burner inside the shop with the roll up door cracked a couple feet",
      "Can I put a propane heater next to the furnace in the basement?",
    ])
      expect(isCoHazardQuestion(q), q).toBe(true);
    for (const q of ["Can I light the propane stove in my RV kitchen?", "Is it safe to use a direct-vent propane heater in the bedroom?"])
      expect(isCoHazardQuestion(q), q).toBe(false);
  });
});


describe("coHazardAnswer", () => {
  it("leads with No. on a yes/no planning question only, and ends with sources and the emergency line", () => {
    const yesNo = coHazardAnswer("Can I run my generator in the garage?");
    expect(yesNo).toMatch(/^No\. Carbon monoxide/);
    expect(yesNo).toMatch(/Based on: CDC/);
    expect(yesNo).toMatch(/emergency/i);
    expect(coHazardAnswer("Where should I put the generator, garage or outside?")).toMatch(/^Carbon monoxide/);
  });
});

describe("vehicle cabins (native app suite, 2026-10-18)", () => {
  it("a fuel heater or stove in a car, SUV or truck cab fires; car questions without a burner do not", () => {
    for (const q of [
      "Can I run a propane heater in the car?",
      "Can I sleep in my SUV with a small gas heater on?",
      "Can I cook with a camping stove inside my truck cab when it rains?",
    ])
      expect(isCoHazardQuestion(q), q).toBe(true);
    for (const q of [
      "How long does a car battery last?",
      "Can I charge my phone in the car?",
      "Is it okay to bring a propane tank in the car to the campsite?",
    ])
      expect(isCoHazardQuestion(q), q).toBe(false);
  });
});

describe("coHazardLanguage (EN/PT/ES, native Labs patterns)", () => {
  it("answers each language in its own words, with the sources", () => {
    expect(coHazardLanguage("Can I run my generator in the garage with the door open?")).toBe("en");
    expect(coHazardLanguage("Posso usar aquecedor a gás dentro da barraca?")).toBe("pt");
    expect(coHazardLanguage("gerador na garagem fechada")).toBe("pt");
    expect(coHazardLanguage("¿Puedo usar un generador dentro del garaje con la puerta abierta?")).toBe("es");
    const pt = coHazardAnswer("Posso usar aquecedor a gás dentro da barraca?", "pt");
    expect(pt).toMatch(/^Não\. O monóxido de carbono/);
    expect(pt).toMatch(/Fontes \(em inglês\): CDC/);
    const es = coHazardAnswer("¿Puedo usar un generador dentro del garaje con la puerta abierta?", "es");
    expect(es).toMatch(/^No\. El monóxido de carbono/);
    expect(es).toMatch(/Fuentes \(en inglés\): CDC/);
  });
  it("leaves out symptoms, the kitchen stove, parking and non-hazards", () => {
    for (const q of [
      "Estamos com dor de cabeça e o gerador está ligado na garagem",
      "Posso usar o fogão a gás na cozinha?",
      "Posso deixar o carro na garagem?",
      "Qual é a capital da França?",
      "¿Cuál es la capital de Francia?",
    ])
      expect(coHazardLanguage(q), q).toBeNull();
  });
});
