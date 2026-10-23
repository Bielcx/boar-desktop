/**
 * Answers that never need a model or a search, decided in one place for both paths that answer a question: answer()
 * (scoped chats, the local API, the bench) and the chat's own routing (ChatScreen). Before, only answer() had them, so
 * the chat sent "generator in the garage" or "is Japan's population larger than Nigeria's?" to the model.
 */
import { isSnakebiteFirstAid, snakebiteFirstAidCard } from "./firstAidCards";
import { coHazardAnswer, coHazardLanguage } from "./coHazard";
import { factsAnswer } from "../rag/facts";
import { emergencyNumbersAnswer } from "./emergencyNumbers";
import { smallTalkReply } from "./smallTalk";
import { calculate } from "./calculators";
import { isHealthQuestion, isPortugueseQuestion, isSafetyQuery, isSpanishQuestion } from "./context";

export interface InstantAnswer {
  text: string;
  modelId: string;
  modelLabel: string;
  reasonCodes: string[];
}

/** The fixed answer for this question, or null when it needs the library and a model. In order: first aid, CO, emergency numbers, small talk, calculators, Wikidata facts. */
export function instantAnswer(query: string, opts: { facts?: boolean; now?: Date } = {}): InstantAnswer | null {
  const pt = isPortugueseQuestion(query);
  // Snakebite first aid: a fixed card from the WHO text, never a pack passage (Boar, after 3ffd7e0).
  if (isSnakebiteFirstAid(query)) {
    return { text: snakebiteFirstAidCard(query, pt), modelId: "grounding-guard", modelLabel: "First aid (WHO)", reasonCodes: ["answer:first-aid-card-snakebite"] };
  }
  // CO hazard (EN/PT/ES): a fuel-burning device in a garage, tent or home is never a model answer (ship L3: "yes, with ventilation").
  const co = coHazardLanguage(query);
  if (co) {
    return { text: coHazardAnswer(query, co), modelId: "grounding-guard", modelLabel: "Safety facts (CDC)", reasonCodes: ["answer:safety-fact-co-hazard"] };
  }
  // A country's emergency numbers: a fixed table, never a guess (Sextant trv-001-pt).
  const numbers = emergencyNumbersAnswer(query, pt);
  if (numbers) return { text: numbers, modelId: "grounding-guard", modelLabel: "Offline library", reasonCodes: ["answer:emergency-numbers"] };
  // Small talk ("hi", "valeu", "who are you", "what time is it"): a fixed reply, no model load, no search.
  const chat = smallTalkReply(query, pt, opts.now ?? new Date());
  if (chat) return { text: chat.text, modelId: "small-talk", modelLabel: "BOAR", reasonCodes: [`answer:small-talk-${chat.kind}`] };
  // Arithmetic (temperature, fuel economy, Naismith, currency at a given rate, battery Wh) is answered exactly.
  const calc = calculate(query, pt);
  if (calc) {
    const code = calc.kind === "temperature" ? "temperature-conversion" : `calculator-${calc.kind}`;
    return { text: calc.text, modelId: "calculator", modelLabel: "Calculator", reasonCodes: [`answer:${code}`] };
  }
  // FACTS (coordinator arm, criterion arms/facts 4328960e): a fact from the offline Wikidata table when the question names a
  // table entity and asks exactly one property; comparisons get a computed verdict. Never on a health or safety message (EN only).
  const fact =
    opts.facts === false || pt || isSpanishQuestion(query) || isHealthQuestion(query) || isSafetyQuery(query) ? null : factsAnswer(query);
  if (fact) return { text: fact.text, modelId: "grounding-guard", modelLabel: "Offline facts (Wikidata)", reasonCodes: [`answer:facts-${fact.template}`] };
  return null;
}
