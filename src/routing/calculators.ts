/**
 * Arithmetic questions answered exactly, with the formula, instead of by a model (Sextant, gate 3ccf7c0: the
 * compact model got 5 PT math questions wrong: fuel economy, Naismith's rule, currency with a given rate, a
 * battery's watt-hours for a flight, a heat warning). Pure: the question in, the answer text out (or null).
 */
import { temperatureConversion } from "./context";

export type CalculatorKind = "temperature" | "fuel-economy" | "naismith" | "currency" | "battery" | "water";
export interface Calculation {
  kind: CalculatorKind;
  text: string;
}

const NUM = String.raw`(\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)`;

/** "7,5" / "7.5" / "2.450" (PT thousands) / "1,200.5" / "18" -> number. */
export function parseNumber(raw: string, pt: boolean): number {
  const s = raw.replace(/\s/g, "");
  if (s.includes(",") && s.includes(".")) return Number(s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, ""));
  if (s.includes(",")) return /,\d{3}$/.test(s) && !pt ? Number(s.replace(/,/g, "")) : Number(s.replace(",", "."));
  if (s.includes(".")) return /\.\d{3}$/.test(s) && pt ? Number(s.replace(/\./g, "")) : Number(s);
  return Number(s);
}

const fmt = (n: number, pt: boolean, digits = 2) =>
  n.toLocaleString(pt ? "pt-BR" : "en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

// (a) Fuel economy: L/100 km <-> miles per gallon (US 235.215, UK 282.481).
function fuelEconomy(q: string, pt: boolean): string | null {
  const uk = /\b(uk|imperial|brit[âa]nic[oa]|ingl[eê]s)\b/i.test(q);
  const k = uk ? 282.481 : 235.215;
  const gal = pt ? (uk ? "galão imperial" : "galão americano") : uk ? "UK gallon" : "US gallon";
  const l100 = new RegExp(`${NUM}\\s*(?:l|litros?|liters?|litres?)\\s*(?:/|a cada|por|per|every|each)\\s*100\\s*km`, "i").exec(q);
  if (l100 && /\b(mpg|milhas? por gal[ãa]o|miles? per (?:us |uk |imperial )?gallon|mi\/gal)\b/i.test(q)) {
    const x = parseNumber(l100[1], pt);
    if (!(x > 0)) return null;
    const mpg = k / x;
    return pt
      ? `${fmt(x, pt)} L/100 km = ${fmt(mpg, pt)} milhas por galão (${gal}). Conta: mpg = ${fmt(k, pt, 3)} ÷ L/100 km.`
      : `${fmt(x, pt)} L/100 km = ${fmt(mpg, pt)} miles per gallon (${gal}). Formula: mpg = ${fmt(k, pt, 3)} ÷ L/100 km.`;
  }
  const mpgM = new RegExp(`${NUM}\\s*(?:mpg|milhas? por gal[ãa]o|miles? per (?:us |uk |imperial )?gallon)`, "i").exec(q);
  if (mpgM && /l\s*\/\s*100|litros? (a cada|por) 100|liters? per 100/i.test(q)) {
    const x = parseNumber(mpgM[1], pt);
    if (!(x > 0)) return null;
    return pt
      ? `${fmt(x, pt)} milhas por galão (${gal}) = ${fmt(k / x, pt)} L/100 km. Conta: L/100 km = ${fmt(k, pt, 3)} ÷ mpg.`
      : `${fmt(x, pt)} miles per gallon (${gal}) = ${fmt(k / x, pt)} L/100 km. Formula: L/100 km = ${fmt(k, pt, 3)} ÷ mpg.`;
  }
  return null;
}

// (b) Naismith's rule: 1 h per 5 km, plus 1 h per 600 m of ascent.
function naismith(q: string, pt: boolean): string | null {
  if (!/naismith/i.test(q)) return null;
  const km = new RegExp(`${NUM}\\s*km\\b`, "i").exec(q);
  const up = new RegExp(`${NUM}\\s*m\\b(?![a-z])`, "i").exec(q.replace(km?.[0] ?? "", ""));
  if (!km) return null;
  const d = parseNumber(km[1], pt);
  const a = up ? parseNumber(up[1], pt) : 0;
  const h = d / 5 + a / 600;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return pt
    ? `Pela regra de Naismith: ${fmt(d, pt)} km ÷ 5 km/h + ${fmt(a, pt, 0)} m ÷ 600 m/h = ${fmt(h, pt, 1)} h (cerca de ${hh} h ${mm} min), sem contar paradas.`
    : `By Naismith's rule: ${fmt(d, pt)} km ÷ 5 km/h + ${fmt(a, pt, 0)} m ÷ 600 m/h = ${fmt(h, pt, 1)} h (about ${hh} h ${mm} min), not counting stops.`;
}

// (c) Currency with the rate the question gives, and an optional tip.
function currency(q: string, pt: boolean): string | null {
  const rate = new RegExp(
    `\\b1\\s*(?:u\\.?s\\.?\\s+)?(d[óo]lar(?:es)?(?: americanos?)?|us\\$|usd|euros?|eur|€|libras?|gbp|reais|real|brl|r\\$|dollars?(?: us)?)\\s*(?:vale|valem|=|equals|is worth|is|custa)\\s*${NUM}\\s*([\\p{L}$€£]+(?: [\\p{L}]+)?)?`,
    "iu"
  ).exec(q);
  if (!rate) return null;
  const r = parseNumber(rate[2], pt);
  const rest = q.replace(rate[0], " ");
  const amountM = new RegExp(`${NUM}\\s*(?!%)(?!\\s*%)([\\p{L}$€£]+)?`, "iu").exec(rest.replace(new RegExp(`${NUM}\\s*%`, "g"), " "));
  if (!amountM || !(r > 0)) return null;
  const amount = parseNumber(amountM[1], pt);
  const unitFrom = (amountM[2] ?? rate[3] ?? "").trim();
  const unitTo = rate[1].replace(/es$/i, "").toLowerCase().startsWith("d") ? (pt ? "dólares" : "US dollars") : rate[1];
  const converted = amount / r;
  let text = pt
    ? `${fmt(amount, pt)} ${unitFrom} ÷ ${fmt(r, pt)} = ${fmt(converted, pt)} ${unitTo}.`
    : `${fmt(amount, pt)} ${unitFrom} ÷ ${fmt(r, pt)} = ${fmt(converted, pt)} ${unitTo}.`;
  const tipM = new RegExp(`${NUM}\\s*%`).exec(q);
  if (tipM && /gorjeta|tip|servi[çc]o|gratuity/i.test(q)) {
    const t = parseNumber(tipM[1], pt);
    const total = converted * (1 + t / 100);
    text += pt
      ? ` Com ${fmt(t, pt)}% de gorjeta: ${fmt(total, pt)} ${unitTo} (gorjeta de ${fmt(converted * (t / 100), pt)}).`
      : ` With a ${fmt(t, pt)}% tip: ${fmt(total, pt)} ${unitTo} (tip ${fmt(converted * (t / 100), pt)}).`;
  }
  return text.replace(/\s+\./g, ".").replace(/\s{2,}/g, " ");
}

// (d) Battery energy: Wh = mAh × V / 1000, with the airline limits (IATA/FAA: up to 100 Wh in carry-on;
// 100-160 Wh with the airline's approval; above 160 Wh not allowed; spare batteries never in checked bags).
function battery(q: string, pt: boolean): string | null {
  const mah = new RegExp(`${NUM}\\s*mah\\b`, "i").exec(q);
  const v = new RegExp(`${NUM}\\s*v\\b`, "i").exec(q);
  if (!mah || !v) return null;
  const wh = (parseNumber(mah[1], pt) * parseNumber(v[1], pt)) / 1000;
  let text = pt
    ? `${fmt(parseNumber(mah[1], pt), pt, 0)} mAh × ${fmt(parseNumber(v[1], pt), pt)} V ÷ 1000 = ${fmt(wh, pt)} Wh.`
    : `${fmt(parseNumber(mah[1], pt), pt, 0)} mAh × ${fmt(parseNumber(v[1], pt), pt)} V ÷ 1000 = ${fmt(wh, pt)} Wh.`;
  if (/avi[ãa]o|voo|voar|bagagem|companhia a[ée]rea|plane|flight|fly|airline|carry[- ]on|luggage/i.test(q)) {
    text += wh <= 100
      ? pt
        ? " Sim, pode levar no avião: até 100 Wh é permitido na bagagem de mão (não na despachada)."
        : " Yes, you can take it on a plane: up to 100 Wh is allowed in carry-on baggage (not in checked bags)."
      : wh <= 160
        ? pt
          ? " Entre 100 e 160 Wh, só na bagagem de mão e com aprovação da companhia aérea."
          : " Between 100 and 160 Wh it needs the airline's approval, in carry-on baggage only."
        : pt
          ? " Acima de 160 Wh, não é permitido em voos de passageiros."
          : " Above 160 Wh it is not allowed on passenger flights.";
  }
  return text;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  um: 1, uma: 1, dois: 2, duas: 2, "três": 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};
const COUNT = String.raw`(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|um|uma|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)`;
const count = (w: string, pt: boolean) => WORD_NUMBERS[w.toLowerCase()] ?? parseNumber(w, pt);

// (f) Water for a trip: people × days × litres per person per day; 1 L of water weighs about 1 kg.
function water(q: string, pt: boolean): string | null {
  if (!/(?<![\p{L}])(water|[áa]gua)(?![\p{L}])/iu.test(q)) return null;
  const perDay = new RegExp(`${NUM}\\s*(?:l|litros?|liters?|litres?)\\b[^.?!]{0,30}?(?:por dia|per day|a day|/dia|/day)`, "i").exec(q);
  const people = new RegExp(`\\b(?:somos|we are|we're)\\s+${COUNT}\\b|\\b${COUNT}\\s+(?:of us|people|persons|pessoas|adultos|adults|hikers)\\b`, "i").exec(q);
  const days = new RegExp(`\\b${COUNT}[\\s-]+(?:days?|dias?)\\b`, "i").exec(q);
  if (!perDay || !people || !days) return null;
  const l = parseNumber(perDay[1], pt);
  const p = count(people[1] ?? people[2], pt);
  const d = count(days[1], pt);
  if (!(l > 0 && p > 0 && d > 0)) return null;
  const total = l * p * d;
  return pt
    ? `${fmt(p, pt, 0)} pessoas × ${fmt(d, pt, 0)} dias × ${fmt(l, pt)} L = ${fmt(total, pt)} litros de água, que pesam cerca de ${fmt(total, pt)} kg (1 L de água ≈ 1 kg).`
    : `${fmt(p, pt, 0)} people × ${fmt(d, pt, 0)} days × ${fmt(l, pt)} L = ${fmt(total, pt)} liters of water, weighing about ${fmt(total, pt)} kg (1 L of water ≈ 1 kg).`;
}

// (e) A temperature, plus the heat warning when the question asks if it's dangerous (or it clearly is).
function temperature(q: string, pt: boolean): string | null {
  const base = temperatureConversion(q, pt);
  if (!base) return null;
  const c = /(-?[\d.,]+)\s*°C/.exec(base.split("=").map((x) => x.trim()).find((x) => /°C/.test(x)) ?? "");
  const celsius = c ? parseNumber(c[1], pt) : NaN;
  const asks = /perig|segur|caminh|trilha|correr|exerc|danger|safe|hike|hiking|walk|run|exercise/i.test(q);
  if (!Number.isFinite(celsius) || !(asks && celsius >= 32)) return base;
  const note =
    celsius >= 40
      ? pt
        ? " Sim, é perigoso: a 40 °C ou mais o esforço físico traz alto risco de exaustão pelo calor e insolação. Se precisar sair, evite as horas mais quentes, beba água com frequência e descanse na sombra."
        : " Yes, it is dangerous: at 40 °C or more, physical effort carries a high risk of heat exhaustion and heatstroke. If you must go, avoid the hottest hours, drink water often and rest in the shade."
      : pt
        ? " Calor forte: acima de 32-35 °C o risco de exaustão pelo calor sobe com esforço físico. Evite as horas mais quentes, beba água e faça pausas na sombra."
        : " Strong heat: above 32-35 °C the risk of heat exhaustion rises with effort. Avoid the hottest hours, drink water and take breaks in the shade.";
  return base + note;
}

/** The exact answer to an arithmetic question, or null. Order: the most specific first. */
export function calculate(query: string, pt: boolean): Calculation | null {
  const tries: Array<[CalculatorKind, (q: string, pt: boolean) => string | null]> = [
    ["battery", battery],
    ["fuel-economy", fuelEconomy],
    ["naismith", naismith],
    ["currency", currency],
    ["water", water],
    ["temperature", temperature],
  ];
  for (const [kind, fn] of tries) {
    const text = fn(query, pt);
    if (text) return { kind, text };
  }
  return null;
}
