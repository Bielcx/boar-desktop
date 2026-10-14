import { describe, it, expect } from "vitest";
import { calculate, parseNumber } from "./calculators";

describe("calculators (Sextant, gate 3ccf7c0, v2-pt math)", () => {
  it("parses PT and EN numbers", () => {
    expect(parseNumber("7,5", true)).toBe(7.5);
    expect(parseNumber("2.450", true)).toBe(2450);
    expect(parseNumber("1.200", true)).toBe(1200);
    expect(parseNumber("36,5", true)).toBe(36.5);
    expect(parseNumber("7.5", false)).toBe(7.5);
    expect(parseNumber("1,200", false)).toBe(1200);
  });
  const cases: Array<[string, string, boolean, RegExp[]]> = [
    ["mth-001-pt", "Meu carro alugado faz 7,5 litros a cada 100 km. Quanto isso dá em milhas por galão americano?", true, [/31,36 milhas por galão \(galão americano\)/]],
    ["mth-001", "My rental car uses 7.5 liters per 100 km. What is that in miles per US gallon?", false, [/31\.36 miles per gallon \(US gallon\)/]],
    ["mth-002-pt", "Uma trilha tem 18 km e 1.200 m de subida no total. Pela regra de Naismith, quanto tempo ela leva, mais ou menos?", true, [/= 5,6 h \(cerca de 5 h 36 min\)/]],
    ["mth-002", "A hike is 18 km with 1,200 m of total climbing. Using Naismith's rule, about how long will it take?", false, [/= 5\.6 h \(about 5 h 36 min\)/]],
    ["mth-003-pt", "Minha conta do jantar deu 2.450 baht tailandeses e 1 dólar americano vale 36,5 baht. Quanto dá em dólares, e qual o total com 10% de gorjeta?", true, [/= 67,12 dólares/, /Com 10% de gorjeta: 73,84 dólares/]],
    ["mth-003", "My dinner bill is 2,450 Thai baht and 1 US dollar is 36.5 baht. How much is that in dollars, and what is the total with a 10% tip?", false, [/= 67\.12 US dollars/, /With a 10% tip: 73\.84 US dollars/]],
    ["mth-004-pt", "Somos três fazendo uma trilha de dois dias e cada pessoa precisa de 3 litros de água por dia. Quanta água precisamos e quanto isso pesa?", true, [/3 pessoas × 2 dias × 3 L = 18 litros de água, que pesam cerca de 18 kg/]],
    ["mth-004", "Three of us are hiking for two days and each person needs 3 liters of water per day. How much water do we need and how much does it weigh?", false, [/3 people × 2 days × 3 L = 18 liters of water, weighing about 18 kg/]],
    ["mth-005-pt", "Meu power bank é de 5.000 mAh a 3,85 V. Quantos watt-hora isso dá, e posso levar no avião?", true, [/= 19,25 Wh\. Sim, pode levar no avião: até 100 Wh é permitido na bagagem de mão/]],
    ["mth-005", "My power bank is 5,000 mAh at 3.85 V. How many watt-hours is that, and can I take it on a plane?", false, [/= 19\.25 Wh\. Yes, you can take it on a plane/]],
    ["mth-006-pt", "Está fazendo 104 °F lá fora. Quanto é isso em Celsius, e é perigoso fazer uma caminhada longa?", true, [/104 °F = 40 °C/, /Sim, é perigoso/]],
    ["mth-006", "It's 104°F outside. What is that in Celsius, and is it dangerous for a long walk?", false, [/104 °F = 40 °C/, /Yes, it is dangerous/]],
  ];
  for (const [id, q, pt, expects] of cases) {
    it(`${id}: ${q.slice(0, 50)}`, () => {
      const r = calculate(q, pt);
      expect(r, id).not.toBeNull();
      for (const re of expects) expect(r!.text, id).toMatch(re);
    });
  }
  it("30 °C in Fahrenheit is unchanged (RF-1 suggestion)", () => {
    expect(calculate("What is 30 °C in Fahrenheit?", false)!.text).toBe("30 °C = 86 °F (°F = °C × 9/5 + 32).");
  });
  it("no calculator for ordinary questions", () => {
    for (const q of ["What is the capital of France?", "Quais são os melhores restaurantes em Bangkok?", "How do I stop a nosebleed?", "Why is 30 °C hot?"]) expect(calculate(q, /Quais|melhores/.test(q)), q).toBeNull();
  });
});
