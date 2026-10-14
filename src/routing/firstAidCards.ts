/**
 * Fixed first-aid cards for conditions where the offline packs can't be trusted to give the practical step (Boar,
 * after gate 3ffd7e0: with packs, the snakebite answer became "the source doesn't give the steps" + emergency, once
 * the contested "pressure immobilization" passage was blocked). Text reviewed by Boar, only what its source says.
 * Source: WHO, Questions and answers, "Snakebite envenoming" (20 November 2019),
 * https://www.who.int/news-room/questions-and-answers/item/snakebite-envenoming — "The best approach is to
 * immobilize the bitten person and keep them from moving around at all." / "…transport them to medical care
 * without delay." / narrow tourniquets, incision, chemicals, suction "can all be dangerous as well as ineffective
 * and should not be used." Plus "move away from the snake" (Boar-approved; avoids a second bite). "Keep still",
 * never "immobilize" (not to be confused with pressure immobilization). Pure.
 */
import { emergencyLine } from "./context";
import { emergencyNumbersLine } from "./emergencyNumbers";

const SNAKE = /(?<![\p{L}])(snakes?|vipers?|rattlesnakes?|cobras?|serpentes?|jararacas?|cascav[ée]is|cascavel|surucucus?)(?![\p{L}])/iu;
const BITE = /(?<![\p{L}])(bit|bitten|bite|bites|biting|snakebite|picad[oa]s?|picou|mordid[oa]s?|mordeu|mordida|picada)(?![\p{L}])/iu;
const AID =
  /\b(what (do|should|can) (i|we|he|she|they) do|what to do|first aid|help|now)\b|(?<![\p{L}])(o que (eu )?(fa[çc]o|fazer|devo fazer)|como (agir|socorrer)|primeiros socorros|socorro|ajuda|agora)(?![\p{L}])/iu;

/** A snakebite first-aid question ("fui picado por uma cobra, o que faço?"), not a question about snakes. */
export function isSnakebiteFirstAid(query: string): boolean {
  return SNAKE.test(query) && BITE.test(query) && AID.test(query);
}

export function snakebiteFirstAidCard(query: string, pt: boolean): string {
  const emergency = emergencyNumbersLine(query, pt) ?? emergencyLine(pt);
  return pt
    ? "Picada de cobra, primeiros socorros: afaste-se da cobra e não tente pegá-la nem matá-la. Mantenha a pessoa parada e calma, sem se mexer; se der, carregue-a numa maca improvisada e leve-a ao atendimento médico sem demora. NÃO use torniquete apertado, NÃO corte o local e NÃO chupe o veneno nem passe produtos químicos.\n\n" +
        "Fonte: OMS, perguntas e respostas sobre picada de cobra (2019).\n\n" +
        emergency
    : "Snakebite, first aid: move away from the snake and don't try to catch or kill it. Keep the person still and calm, and stop them from moving around at all; carry them on a makeshift stretcher if you can, and get them to medical care without delay. Do NOT use a tight tourniquet, do NOT cut the wound, and do NOT suck the venom or put chemicals on it.\n\n" +
        "Source: WHO, questions and answers on snakebite envenoming (2019).\n\n" +
        emergency;
}
