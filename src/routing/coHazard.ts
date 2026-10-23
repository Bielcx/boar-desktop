// CO hazard (Compass 2026-10-03, ship L3 safety finding): "Can I run my portable generator in the attached garage if I keep
// the door open?" took the model path and got "Yes, … ensure it's well-ventilated". A planning question about a
// fuel-burning device in an enclosed or attached space now gets a fixed safety-fact answer, before any model.
// English (mobile expo branch), plus the native app's Portuguese and Spanish patterns and draft answers (bottom of the file).
// Symptom or alarm questions are left to the normal health route (desktop has no CO condition card, so the mobile
// isCoExposure* helpers are not ported).
// Wording: Opus reviewer 2026-10-03 (REVIEWER.md, CHANGE applied). Sources (verbatim, compass/exp/co-hazard/SOURCES.md): CDC "What to Do to Protect Yourself During a Power Outage";
// US CPSC "Generators and Engine-Driven Tools"; NHS "Carbon monoxide poisoning".
import { emergencyLine, isPortugueseQuestion, isSpanishQuestion } from "./context";
import { emergencyNumbersLine } from "./emergencyNumbers";

const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";
const re = (s: string) => new RegExp(s, "iu");

/** A device that burns fuel. A plain "grill", "stove" or "heater" may be electric, so those need a fuel word. */
const DEVICE = re(
  [
    `${B}(?<!(?:random|number|code|site|password|static|image|text|qr|name|idea|key|signal|function|pulse|lorem|tone|wave|pdf|report|hash|ai|music|art|map|meme|solar|battery|jackery|ecoflow|bluetti)[ -])(?:generators?|gennys?|gennies)${E}`,
    `${B}(?<!activated )charcoal${E}(?! (?:drawing|pencil|filter|tablet|pill|capsule|mask|soap|toothpaste|grey|gray|colou?r|sketch|powder|supplement))`,
    `${B}(?:bbqs?|barbecues?|hibachis?)${E}`,
    `${B}(?:a|the|our|my|your) barbie${E}`,
    `${B}(?:gas|propane|charcoal|pellet|wood|camping|camp|portable gas|disposable) (?:grills?|smokers?)${E}`,
    `${B}(?:camping|camp|backpacking|coleman|primus|portable gas|canister|gas canister) (?:stoves?|burners?)${E}`,
    `${B}(?:propane|gas|kerosene|paraffin|butane|coleman) lanterns?${E}`,
    `${B}(?:gas|gasoline|petrol)[- ]powered${E}`,
    `${B}(?:pressure|power) washers?${E}`,
    `${B}(?:propane|butane|gas|coleman|camp|camping) (?:griddles?|torch(?:es)?|cookers?|rings?|fire ?pits?|lanterns?)${E}`,
    `${B}(?:jetboils?|pocket rockets?|blackstone(?: griddles?)?|weed torch(?:es)?|propane torch(?:es)?)${E}`,
    `${B}(?:kerosene|paraffin|oil) (?:lamps?|lanterns?|stoves?)${E}`,
    `${B}(?:gas|gasoline|petrol) (?:leaf blowers?|blowers?|lawn ?mowers?|mowers?|chainsaws?|engines?|tools?|trimmers?|augers?)${E}`,
  ].join("|")
);

/** Fuel heaters. Reviewer C2: an installed or vented appliance (water heater, furnace, boiler, direct-vent) is not this hazard. */
const HEATER = re(
  [
    `${B}(?:propane|kerosene|paraffin|butane|gas|diesel|oil|fuel|fuel-burning|camping|buddy|patio|catalytic|outdoor)(?: [\\p{L}-]+)? heaters?${E}`,
    `${B}(?:big|little) buddy${E}`,
    `${B}mr\\.? heater${E}`,
  ].join("|")
);
/** Follow-up (coordinator 2026-10-03): an installed appliance named in passing ("the furnace eats the battery") no longer vetoes the
 * whole message. Its name is removed before the heater test; only vented/direct-vent/flued/installed still veto. */
const APPLIANCE = new RegExp(`${B}(?:water heaters?|furnaces?|boilers?)${E}`, "giu");
const INSTALLED = re(`${B}(?:direct[- ]vent\\w*|vented|flued|installed)${E}`);
/** A propane or butane stove counts unless the only space named is a kitchen (a propane kitchen range is a normal appliance). */
const PROPANE_STOVE = re(`${B}(?:propane|butane) (?:stoves?|burners?)${E}`);
const KITCHEN = new RegExp(`${B}(?:(?:rv|camper|caravan|van|boat|motorhome|trailer|apartment|home|house)'?s? )?(?:kitchens?|galleys?)${E}`, "giu");

/** Using a gas oven or range to heat the home (CDC). */
const OVEN_HEAT = re(
  `${B}(?:gas )?(?:oven|stove|range)${E}.{0,40}${B}(?:to|for) (?:heat|warm)` +
    `|${B}(?:heat|heated|heating|warm|warmed|warming)${E}.{0,50}${B}(?:gas )?(?:oven|stove)${E} (?:on|open|with the door)` +
    `|${B}(?:oven|stove)${E} on with the door (?:open|down)`
);

/** An engine left running where the exhaust stays (CDC, NHS): a car warming up in the garage. */
const ENGINE = re(
  `${B}(?:car|truck|vehicle|engine|motor|motorcycle|motorbike|lawn ?mower|mower|chainsaw|snow ?blower|leaf blower|atv|quad|van|suv)s?${E}.{0,40}${B}(?:running|run|idle|idling|on|warm(?:ing)? up|start(?:ed|ing)?)${E}` +
    `|${B}(?:run|running|idle|idling|warm(?:ing)? up|leave|start)${E}.{0,25}${B}(?:car|truck|vehicle|engine|motor|motorcycle|motorbike|lawn ?mower|mower|snow ?blower|suv)s?${E}`
);

/** Generator placement near an opening ("is 10 ft from the back door ok?"): the 20-foot rule. */
const PLACEMENT = re(
  `${B}(?:generators?|gennys?)${E}.{0,80}${B}(?:how far|distance|gap|enough|far enough|minimum|close|ok|okay|safe|\\d+ ?(?:ft|feet|foot|m|metres|meters))${E}.{0,60}${B}(?:windows?|doors?|vents?|intakes?)${E}` +
    `|${B}(?:how far|distance|gap|minimum|\\d+ ?(?:ft|feet|foot|m|metres|meters))${E}.{0,60}${B}(?:windows?|doors?|vents?|intakes?)${E}.{0,60}${B}(?:generators?|gennys?)${E}` +
    `|${B}(?:how far|distance|gap|minimum)${E}.{0,40}${B}(?:generators?|gennys?)${E}.{0,60}${B}(?:windows?|doors?|vents?|intakes?)${E}` +
    `|${B}(?:is|are) \\d+ ?(?:ft|feet|foot|m|metres|meters)${E}.{0,40}${B}(?:windows?|doors?|vents?)${E}` +
    `|${B}(?:generators?|gennys?)${E}.{0,80}${B}(?:right next to|next to|right by|right under|under|beside|near|close to|up against)${E} (?:my |the |our |his |her |their |a |an )?(?:[\\p{L}-]+ ){0,2}(?:windows?|doors?|vents?|hatch(?:es)?)${E}`
);
/** Distances the message states, in feet. Every one at 20 ft (6 m) or more: the generator is already placed right. */
function statedFeet(q: string): number[] {
  return [...q.matchAll(/(\d+(?:\.\d+)?) ?(ft|feet|foot|m|metres|meters)(?![\p{L}])/giu)].map((m) => (/^m/i.test(m[2]) ? Number(m[1]) * 3.28 : Number(m[1])));
}

/** Heating or warming a space with a fuel burner ("warm up the tent with a gas canister stove"). */
const HEAT_SPACE = re(
  `${B}(?:heat|warm)(?:ing)?(?: up)? (?:the |my |our |a )?(?:[\\p{L}-]+ )?(?:tent|room|house|home|apartment|camper|van|cabin|shack|shelter|garage|basement|crawl ?space)${E}.{0,40}${B}(?:stoves?|ovens?|grills?|bbqs?|heaters?|burners?|lanterns?)${E}`
);

/** Storing or winterising, nothing running. */
const STORAGE = re(`${B}(?:stor(?:e|ing|age)|winteri[sz]\\w*|drain(?:ing)?|put (?:it )?away|for the (?:summer|winter|season|off-season))${E}`);
/** Fiction or history writing, not a plan. */
const FICTION = re(`${B}(?:novel|my character|screenplay|short story|fiction|historically|historical)${E}`);
const RUNNING = re(`${B}(?:run|running|use|using|operate|operating|start|starting|turn(?:ed|ing)? on|fire up|light|lighting)${E}`);

/** An enclosed or attached space. Bare "inside" is not enough ("inside the function"). */
const SPACE = re(
  [
    `${B}indoors?${E}`,
    `${B}(?:inside|in|into) (?:the |my |our |a |your |an |his |her |their )?(?:[\\p{L}-]+ ){0,2}(?:house|home|bedroom|living room|apartment|flat|cabin|room|tent|camper|garage|basement|shed|van|minivan|car|suv|truck|truck cab|vehicle|rv|caravan|trailer|motorhome|boat|yurt|hut|shelter|dorm|condo|workshop|barn|porch|sunroom|conservatory)${E}`,
    `${B}garages?${E}(?! (?:sale|band|door opener))`,
    `${B}carports?${E}`,
    `${B}on (?:the |my |our |a )?(?:enclosed |screened |screened-in |covered |closed-in )?(?:porch|sunroom|veranda)${E}`,
    `${B}tents?${E}`,
    `${B}(?:campers?|rvs?|motorhomes?|caravans?|camper ?vans?|travel trailers?)${E}`,
    `${B}(?:basements?|cellars?|crawl ?spaces?|sheds?)${E}`,
    `${B}(?:enclosed|screened[- ]in|closed|covered) (?:porch|patio|balcony|space|area|room|deck)${E}`,
    `${B}(?:ice|fishing|pop-up|popup) (?:fishing )?(?:shack|house|hut|shanty|tent|shelter)s?${E}`,
    `${B}shacks?${E}`,
    // v2 (dev2): a fuel device is already required, so a bare "inside" or a room name is enough here.
    `${B}(?:inside|in here|in there)${E}`,
    `${B}(?:bathrooms?|kitchens?|stalls?|barns?|coops?|stables?|shant(?:y|ies)|cabins?|workshops?|below deck|bunkhouse)${E}`,
    `${B}while (?:we|i|you|they|the kids|everyone) (?:sleep|are asleep|'re asleep)${E}|${B}(?:overnight|all night)${E}`,
  ].join("|")
);

/** Someone may already be poisoned or an alarm is sounding: that is the health route's CO card, not this answer. */
const ACUTE = re(
  `${B}(?:headaches?|head (?:hurts|is (?:pounding|killing me|splitting))|pounding head|dizz\\w*|nause\\w*|vomit\\w*|throwing up|threw up|throw(?:s|n)? up|passed out|faint\\w*|unconscious|confus\\w*|drowsy|sleepy|chest pain|can'?t breathe|short of breath|barely waking|(?:won'?t|can'?t|hard to|not) wak(?:e|ing)(?: up)?|slurr\\w*|feel(?:s|ing)? (?:sick|ill|weird|woozy|weak))${E}` +
    `|${B}(?:alarm|detector)s?${E}.{0,60}${B}(?:going off|went off|beeping|sounding|chirp\\w*|is on|says|reads|reading|shows)${E}|${B}\\d+ ?ppm${E}`
);

/** "Can I / Is it ok to <run|use…>": a request to do it. Only then does the answer start with "No." (reviewer C1). */
const ASK_PERMISSION = re(
  `(?:^|[.?!]\\s+)(?:can|could|may|should|shall) (?:i|we)${E} (?:still |just |safely )?(?:run|use|put|keep|leave|bring|start|operate|light|cook|warm|heat|idle|set up|plug)${E}` +
    `|${B}is it (?:ok|okay|safe|fine|alright|all right) (?:for (?:me|us) )?to${E}`
);
/** Risk questions ("can you die", "is it dangerous"), outdoor or either/or alternatives, installed appliances: a bare "No." would mislead. */
const NO_LEAD_IF = re(
  `${B}(?:dangerous|danger|bad|die|dies|death|kill\\w*|poison\\w*|hurt|harm\\w*|worr\\w*|concern\\w*|risk\\w*|safer|unsafe|outside|outdoors?|out of|yard|driveway|instead|rather|or|not|away|move|moving|vent(?:ed)?|direct-vent|installed|flue|chimney|water heater|furnace|boiler)${E}`
);

/** A fuel-burning device in an enclosed or attached space (or near its openings), symptoms aside. */
function hazardContext(query: string): boolean {
  // Common misspellings (dev2): "generater in the garge", "propain".
  const q = query
    .replace(/[’‘]/g, "'")
    .replace(/(?<![\p{L}])gen[ae]?rat[eoa]?rs?(?![\p{L}])/giu, "generator")
    .replace(/(?<![\p{L}])gar(?:ge|adge|rage)(?![\p{L}])/giu, "garage")
    .replace(/(?<![\p{L}])propain(?![\p{L}])/giu, "propane")
    .replace(/(?<![\p{L}])kerosine(?![\p{L}])/giu, "kerosene");
  if (OVEN_HEAT.test(q) || HEAT_SPACE.test(q)) return true;
  if (PLACEMENT.test(q)) {
    const ft = statedFeet(q);
    if (!(ft.length && ft.every((d) => d >= 19.5))) return true;
  }
  if (!SPACE.test(q)) return false;
  if ((STORAGE.test(q) && !RUNNING.test(q)) || FICTION.test(q)) return false;
  const device =
    DEVICE.test(q) ||
    (HEATER.test(q.replace(APPLIANCE, " ")) && !INSTALLED.test(q)) ||
    (PROPANE_STOVE.test(q) && SPACE.test(q.replace(KITCHEN, " ")));
  return device || (ENGINE.test(q) && /(?<![\p{L}\p{N}_])(?:garages?|carports?|shed|enclosed|basement|crawl ?space)(?![\p{L}\p{N}_])/iu.test(q));
}

/** English question about running a fuel-burning device in an enclosed or attached space (no symptoms, no alarm). */
export function isCoHazardQuestion(query: string): boolean {
  return !ACUTE.test(query.replace(/[’‘]/g, "'")) && hazardContext(query);
}

export const CO_HAZARD_EN =
  "Carbon monoxide (CO) from a generator, a charcoal or gas grill, a camping stove or lantern, or a fuel-burning heater that isn't professionally installed and vented to the outside is a poison you can't see or smell, and it can kill in minutes. " +
  "Never run them inside a home, garage, carport, basement, shed, tent or camper, even with the doors or windows open: that is not enough ventilation. " +
  "Run a generator outside only, at least 20 feet (6 metres) from any door, window or vent, with the exhaust pointing away from buildings. " +
  "Never leave a car or other engine running in a garage, even with the door open, and never heat a home with a gas oven or stove. " +
  "Have a battery-powered CO alarm, but an alarm does not make it safe to run these indoors. " +
  "If anyone gets a headache, dizziness, weakness, tiredness, nausea, vomiting, chest pain or confusion, or passes out, get everyone out into fresh air right away, call emergency services, and don't go back inside until you're told it's safe.";

// "Based on", not "Sources:": the chat drops a trailing "Sources:" list as model-invented (services/citations.ts).
export const CO_HAZARD_SOURCES_EN =
  "Based on: CDC, Power Outage and Carbon Monoxide guidance; US CPSC, Portable Generator Hazards and Generators and Engine-Driven Tools; NHS, Carbon monoxide poisoning.";


// Portuguese and Spanish (native Labs, Oct 18; android-native engine/routing/CoHazard.kt): "Posso usar aquecedor a gás
// dentro da barraca?" went to the model with no warning. The same logic as the English patterns above (a fuel device in an
// enclosed or attached space, an engine in a garage, an oven to heat the home, a generator near a window; symptoms and
// alarms left out), with each language's words. Left out on purpose: a plain "fogão a gás" / "cocina de gas" (the kitchen
// stove), "aquecedor a óleo" / "radiador de aceite" (electric), a wood stove, "deixar/dejar o carro na garagem" (parking,
// not a running engine), a bare "tienda" (a shop; "dentro de la tienda" still counts) and a stated distance with no
// generator named.

/** One language's patterns, in the roles the English ones play in hazardContext, isCoHazardQuestion and coHazardAnswer. */
interface Words {
  device: RegExp; heater: RegExp; appliance: RegExp; installed: RegExp; ovenHeat: RegExp; heatSpace: RegExp;
  engine: RegExp; engineSpace: RegExp; placement: RegExp; feet: RegExp; space: RegExp; storage: RegExp;
  fiction: RegExp; running: RegExp; acute: RegExp; askPermission: RegExp; noLeadIf: RegExp;
}
const reAll = (s: string) => new RegExp(s, "giu");

function wordsFeet(w: Words, q: string): number[] {
  return [...q.matchAll(w.feet)].map((m) => {
    const n = Number(m[1].replace(",", "."));
    return /^m/i.test(m[2]) ? n * 3.28 : n;
  });
}

function wordsHazard(w: Words, query: string): boolean {
  const q = query.replace(/[’‘]/g, "'");
  if (w.acute.test(q)) return false;
  if (w.ovenHeat.test(q) || w.heatSpace.test(q)) return true;
  if (w.placement.test(q)) {
    const ft = wordsFeet(w, q);
    if (!(ft.length && ft.every((d) => d >= 19.5))) return true;
  }
  if (!w.space.test(q)) return false;
  if ((w.storage.test(q) && !w.running.test(q)) || w.fiction.test(q)) return false;
  const device = w.device.test(q) || (w.heater.test(q.replace(w.appliance, " ")) && !w.installed.test(q));
  return device || (w.engine.test(q) && w.engineSpace.test(q));
}

function wordsLead(w: Words, query: string, no: string): string {
  const q = query.replace(/[’‘]/g, "'");
  return w.askPermission.test(q) && !w.noLeadIf.test(q) && !wordsFeet(w, q).some((d) => d >= 19.5) ? no : "";
}

const PT: Words = {
    device: re(
        [
            String.raw`${B}geradore?s?${E}(?! (?:de (?:senhas?|n[úu]meros?|nomes?|c[óo]digos?|qr|textos?|imagens?|ideias?|conte[úu]do|sinais?|fun[çc][õo]es|m[úu]sicas?|arte|memes?|relat[óo]rios?|hash|pdfs?|ru[íi]do|ondas?|vapor|pulsos?)|solar(?:es)?|a bateria|de bateria|com bateria|ia)${E})`,
            String.raw`${B}carv[ãa]o${E}(?! (?:ativado|vegetal ativado|de desenho|para desenho|em p[óo]))(?<!desenho a carv[ãa]o)(?<!l[áa]pis de carv[ãa]o)(?<!filtro de carv[ãa]o)(?<!m[áa]scara de carv[ãa]o)(?<!sabonete de carv[ãa]o)`,
            String.raw`${B}(?:churrasqueiras?|braseiros?|fogareiros?|hibachis?)${E}`,
            String.raw`${B}(?:fog[ãa]o|fog[õo]es) (?:de camping|de acampamento|port[áa]til a g[áa]s|a querosene|a [áa]lcool)${E}`,
            String.raw`${B}(?:lampi[ãa]o|lampi[õo]es|lanternas?) (?:a|de) (?:g[áa]s|querosene|parafina|butano|propano|camping)${E}`,
            String.raw`${B}(?:motor(?:es)?|motosserras?|cortador(?:es)? de grama|ro[çc]adeiras?|sopradores?|lavadoras? de alta press[ãa]o|ferramentas?) (?:a|de) (?:gasolina|diesel|combust[íi]vel)${E}`,
            String.raw`${B}(?:ma[çc]aricos?|bocas? de fog[ãa]o) (?:a|de) (?:g[áa]s|propano|butano)${E}`,
        ].join("|"),
    ),
    heater: re(
        String.raw`${B}(?:aquecedor(?:es)?|estufas?)(?: [\p{L}-]+)? (?:a|de) (?:g[áa]s|querosene|parafina|propano|butano|diesel|combust[íi]vel|camping|p[áa]tio)${E}` +
            String.raw`|${B}(?:aquecedor(?:es)?) (?:externos?|de exterior|catal[íi]ticos?)${E}`,
    ),
    appliance: reAll(String.raw`${B}(?:aquecedor(?:es)? (?:de [áa]gua|de passagem|central)|caldeiras?|boilers?|fornalhas?)${E}`),
    installed: re(String.raw`${B}(?:instalad\p{L}*|com (?:chamin[ée]|duto|exaust[ãa]o|sa[íi]da para fora)|exaust[ãa]o for[çc]ada)${E}`),
    ovenHeat: re(
        String.raw`${B}(?:forno|fog[ãa]o)(?: a g[áa]s)?${E}.{0,40}${B}(?:para|pra) (?:aquecer|esquentar)${E}` +
            String.raw`|${B}(?:aquecer|aquecendo|esquentar|esquentando|aquecid\p{L}*)${E}.{0,50}${B}(?:forno|fog[ãa]o)(?: a g[áa]s)?${E} (?:ligado|aceso|aberto|com a porta)` +
            String.raw`|${B}(?:forno|fog[ãa]o)${E} (?:ligado|aceso) com a porta (?:aberta|abaixada)`,
    ),
    heatSpace: re(
        String.raw`${B}(?:aquecer|esquentar)${E} (?:a |o |minha |meu |nossa |nosso )?(?:[\p{L}-]+ )?(?:barraca|quarto|sala|casa|apartamento|trailer|motorhome|cabana|chal[ée]|garagem|por[ãa]o|abrigo)${E}.{0,40}${B}(?:fogareiros?|fornos?|fog[ãa]o|fog[õo]es|churrasqueiras?|aquecedor(?:es)?|lampi[ãa]o|lampi[õo]es|braseiros?|queimadores?)${E}`,
    ),
    engine: re(
        String.raw`${B}(?:carros?|caminhonetes?|caminh[ãa]o|ve[íi]culos?|motor(?:es)?|motos?|motocicletas?|cortador(?:es)? de grama|ro[çc]adeiras?|motosserras?|quadriciclos?|vans?|suvs?)${E}.{0,40}${B}(?:ligad[oa]s?|funcionando|rodando|em ponto morto|em marcha lenta|esquentando|aquecendo|ligar|ligando)${E}` +
            String.raw`|${B}(?:ligar|ligando|esquentar|aquecer|dar partida)${E}.{0,25}${B}(?:carros?|caminhonetes?|ve[íi]culos?|motor(?:es)?|motos?|motocicletas?|cortador(?:es)? de grama|suvs?)${E}`,
    ),
    engineSpace: re(String.raw`${B}(?:garage(?:m|ns)|abrigos?|por[ãa]o|dep[óo]sito|galp[ãa]o|fechad[oa]s?)${E}`),
    placement: re(
        String.raw`${B}geradore?s?${E}.{0,80}${B}(?:a que dist[âa]ncia|qual dist[âa]ncia|dist[âa]ncia|longe o suficiente|suficiente|m[íi]nim[oa]|perto|ok|seguro|\d+(?:[.,]\d+)? ?(?:m|metros?|p[ée]s))${E}.{0,60}${B}(?:janelas?|portas?|respiros?|entradas? de ar|ventila[çc][õo]es|ventila[çc][ãa]o)${E}` +
            String.raw`|${B}(?:a que dist[âa]ncia|qual dist[âa]ncia|dist[âa]ncia m[íi]nima|\d+(?:[.,]\d+)? ?(?:m|metros?|p[ée]s))${E}.{0,60}${B}(?:janelas?|portas?|respiros?)${E}.{0,60}${B}geradore?s?${E}` +
            String.raw`|${B}geradore?s?${E}.{0,80}${B}(?:bem ao lado|ao lado|perto|pertinho|junto|embaixo|debaixo|encostado)${E} (?:d[aeo]s? |à |ao )?(?:minha |meu |nossa |nosso )?(?:[\p{L}-]+ ){0,2}(?:janelas?|portas?|respiros?)${E}`,
    ),
    feet: new RegExp(String.raw`(\d+(?:[.,]\d+)?) ?(m|metros?|p[ée]s|ft)(?![\p{L}])`, "giu"),
    space: re(
        [
            String.raw`${B}(?:dentro|em|no|na|nos|nas|num|numa|para dentro)(?: d[aeo]s?| de)? (?:minha |meu |nossa |nosso |sua |seu |uma |um )?(?:[\p{L}-]+ ){0,2}(?:casa|quartos?|salas?|apartamentos?|cabanas?|chal[ée]s?|barracas?|trailers?|motorhomes?|garage(?:m|ns)|por[ãa]o|por[õo]es|dep[óo]sitos?|galp[ãa]o|ed[íi]culas?|vans?|kombis?|barcos?|cabines?|banheiros?|cozinhas?|celeiros?|est[áa]bulos?|oficinas?|abrigos?|quitinetes?|kitnets?|carros?|caminhonetes?|ve[íi]culos?)${E}`,
            String.raw`${B}garage(?:m|ns)${E}(?! (?:sale|band))`,
            String.raw`${B}(?:barracas?|trailers?|motorhomes?|por[ãa]o|por[õo]es|galp[ãa]o)${E}(?! de praia)`,
            String.raw`${B}(?:varanda|[áa]rea|lugar|local|ambiente|espa[çc]o|c[ôo]modo|quarto|sala|garagem) (?:fechad[oa]|coberto e fechado|sem ventila[çc][ãa]o)${E}`,
            String.raw`${B}(?:dentro|aqui dentro|l[áa] dentro|em ambiente fechado|em lugar fechado)${E}`,
            String.raw`${B}(?:enquanto (?:a gente|n[óo]s|eu|voc[êe]|eles|as crian[çc]as|todos?) dorm\p{L}*|durante a noite|a noite toda|de madrugada)${E}`,
        ].join("|"),
    ),
    storage: re(String.raw`${B}(?:guardar|guardando|guardad[oa]|armazen\p{L}*|estocar|esvaziar|drenar|para o inverno|fora de temporada)${E}`),
    fiction: re(String.raw`${B}(?:romance|meu personagem|roteiro|conto|fic[çc][ãa]o|historicamente|hist[óo]ric[oa])${E}`),
    running: re(String.raw`${B}(?:usar|usando|ligar|ligando|ligad[oa]|acender|acendendo|aces[oa]|funcionar|funcionando|rodar|rodando|operar|dar partida|cozinhar)${E}`),
    acute: re(
        String.raw`${B}(?:dor(?:es)? de cabe[çc]a|cabe[çc]a (?:d[óo]i|doendo|latejando|explodindo)|tontu\p{L}*|tont[oa]s?|zonz[oa]s?|enjo\p{L}*|n[áa]usea\p{L}*|vomit\p{L}*|v[ôo]mito\p{L}*|desmai\p{L}*|inconscient\p{L}*|confus\p{L}*|sonol[êe]n\p{L}*|dor no peito|falta de ar|sem ar|n[ãa]o (?:consigo|consegue) respirar|n[ãa]o (?:acorda|consegue acordar)|dif[íi]cil de acordar|fala enrolada|passando mal|(?:me )?sentindo (?:mal|estranh\p{L}*|frac[oa]))${E}` +
            String.raw`|${B}(?:alarmes?|detector(?:es)?|sensor(?:es)?)${E}.{0,60}${B}(?:tocando|tocou|disparou|disparando|apitando|apitou|bipando|soando|est[áa] ligado|mostra|marca|indica)${E}|${B}\d+ ?ppm${E}`,
    ),
    askPermission: re(
        String.raw`(?:^|[.?!]\s+)(?:eu |n[óo]s |a gente )?(?:posso|podemos|pode|d[áa] para|d[áa] pra|devo|devemos)(?: ainda| s[óo]| tranquilamente)? (?:usar|ligar|deixar|colocar|botar|p[ôo]r|levar|trazer|acender|cozinhar|aquecer|esquentar|rodar|operar|manter|montar)${E}` +
            String.raw`|${B}(?:[ée]|seria) (?:seguro|ok|tranquilo)${E}|${B}tudo bem${E}|${B}tem problema${E}`,
    ),
    noLeadIf: re(
        String.raw`${B}(?:perigos\p{L}*|perigo|faz mal|morr\p{L}*|morte|mata|matar|envenen\p{L}*|intoxic\p{L}*|risco\p{L}*|arriscad\p{L}*|mais seguro|preocup\p{L}*|fora|ao ar livre|quintal|em vez|ao inv[ée]s|ou|n[ãa]o|longe|tirar|mover|ventilad\p{L}*|exaust\p{L}*|chamin[ée]|instalad\p{L}*|aquecedor de [áa]gua|caldeira)${E}`,
    ),
};

const ES: Words = {
    device: re(
        [
            String.raw`${B}generador(?:es)?${E}(?! (?:de (?:contrase[ñn]as?|n[úu]meros?|nombres?|c[óo]digos?|qr|textos?|im[áa]genes?|ideas?|contenido|se[ñn]ales?|funciones|m[úu]sica|arte|memes?|informes?|hash|pdfs?|ruido|ondas?|vapor|pulsos?)|solar(?:es)?|a bater[íi]a|de bater[íi]a|con bater[íi]a|ia)${E})`,
            String.raw`${B}carb[óo]n${E}(?! (?:activado|vegetal activado|de dibujo|para dibujo|en polvo|mineral activado|monoxide|dioxide|fiber|fibre|footprint|copy))(?<!dibujo al carb[óo]n)(?<!l[áa]piz de carb[óo]n)(?<!filtro de carb[óo]n)(?<!mascarilla de carb[óo]n)(?<!jab[óo]n de carb[óo]n)(?<!monóxido de carb[óo]n)`,
            String.raw`${B}(?:barbacoas?|braseros?|hornillos?|infiernillos?|hibachis?)${E}`,
            String.raw`${B}(?:parrillas?|asadores?) (?:de|a) (?:carb[óo]n|gas|le[ñn]a|propano|butano)${E}`,
            String.raw`${B}(?:estufas?|cocinas?) (?:de camping|de campamento|port[áa]til(?:es)? de gas)${E}`,
            String.raw`${B}(?:farol(?:es)?|faroles?|l[áa]mparas?|linternas?) (?:de|a) (?:gas|queroseno|keroseno|parafina|butano|propano|camping)${E}`,
            String.raw`${B}(?:motor(?:es)?|motosierras?|cortac[ée]sped(?:es)?|podadoras?|sopladores?|hidrolavadoras?|herramientas?) (?:de|a) (?:gasolina|di[ée]sel|combustible)${E}`,
            String.raw`${B}(?:sopletes?|quemadores?) (?:de|a) (?:gas|propano|butano)${E}`,
        ].join("|"),
    ),
    heater: re(
        String.raw`${B}(?:calentador(?:es)?|estufas?|calefactor(?:es)?)(?: [\p{L}-]+)? (?:de|a) (?:gas|queroseno|keroseno|parafina|propano|butano|di[ée]sel|combustible|camping|exterior|terraza)${E}` +
            String.raw`|${B}(?:calentador(?:es)?|estufas?) (?:catal[íi]tic[oa]s?|de exterior)${E}`,
    ),
    appliance: reAll(String.raw`${B}(?:calentador(?:es)? de agua|termos?|calderas?|calefacci[óo]n central|boilers?)${E}`),
    installed: re(String.raw`${B}(?:instalad\p{L}*|con (?:chimenea|ducto|conducto|salida al exterior|tiro)|tiro forzado|ventilad\p{L}* al exterior)${E}`),
    ovenHeat: re(
        String.raw`${B}(?:horno|estufa|cocina)(?: de gas)?${E}.{0,40}${B}para (?:calentar|templar)${E}` +
            String.raw`|${B}(?:calentar|calentando|calentad\p{L}*)${E}.{0,50}${B}(?:horno|estufa|cocina)(?: de gas)?${E} (?:encendid[oa]|prendid[oa]|abiert[oa]|con la puerta)` +
            String.raw`|${B}(?:horno|estufa)${E} (?:encendid[oa]|prendid[oa]) con la puerta (?:abierta|baja)`,
    ),
    heatSpace: re(
        String.raw`${B}calentar${E} (?:la |el |mi |nuestra |nuestro )?(?:[\p{L}-]+ )?(?:tienda|carpa|habitaci[óo]n|cuarto|sala|casa|apartamento|piso|caravana|autocaravana|caba[ñn]a|garaje|s[óo]tano|refugio)${E}.{0,40}${B}(?:hornillos?|hornos?|estufas?|parrillas?|barbacoas?|calentador(?:es)?|faroles?|braseros?|quemadores?)${E}`,
    ),
    engine: re(
        String.raw`${B}(?:coches?|carros?|autos?|camionetas?|cami[óo]n|veh[íi]culos?|motor(?:es)?|motos?|motocicletas?|cortac[ée]sped(?:es)?|podadoras?|motosierras?|cuatrimotos?|furgonetas?|suvs?)${E}.{0,40}${B}(?:encendid[oa]s?|prendid[oa]s?|funcionando|en marcha|al ralent[íi]|calentando|encender|arrancar)${E}` +
            String.raw`|${B}(?:encender|prender|calentar|arrancar)${E}.{0,25}${B}(?:coches?|carros?|autos?|camionetas?|veh[íi]culos?|motor(?:es)?|motos?|motocicletas?|cortac[ée]sped(?:es)?|suvs?)${E}`,
    ),
    engineSpace: re(String.raw`${B}(?:garajes?|cocheras?|s[óo]tanos?|cobertizos?|cerrad[oa]s?)${E}`),
    placement: re(
        String.raw`${B}generador(?:es)?${E}.{0,80}${B}(?:a qu[ée] distancia|qu[ée] distancia|distancia|suficientemente lejos|suficiente|m[íi]nim[oa]|cerca|bien|seguro|\d+(?:[.,]\d+)? ?(?:m|metros?|pies))${E}.{0,60}${B}(?:ventanas?|puertas?|rejillas?|ventilaciones?|tomas? de aire)${E}` +
            String.raw`|${B}(?:a qu[ée] distancia|qu[ée] distancia|distancia m[íi]nima|\d+(?:[.,]\d+)? ?(?:m|metros?|pies))${E}.{0,60}${B}(?:ventanas?|puertas?|rejillas?)${E}.{0,60}${B}generador(?:es)?${E}` +
            String.raw`|${B}generador(?:es)?${E}.{0,80}${B}(?:justo al lado|al lado|junto|cerca|pegado|debajo|bajo)${E} (?:de |a )?(?:la |el |mi |nuestra |nuestro |una |un )?(?:[\p{L}-]+ ){0,2}(?:ventanas?|puertas?|rejillas?)${E}`,
    ),
    feet: new RegExp(String.raw`(\d+(?:[.,]\d+)?) ?(m|metros?|pies|ft)(?![\p{L}])`, "giu"),
    space: re(
        [
            String.raw`${B}(?:dentro|adentro|en|al)(?: de| del)? (?:la |el |los |las |mi |mis |nuestra |nuestro |una |un |tu |su )?(?:[\p{L}-]+ ){0,2}(?:casa|habitaci[óo]n|habitaciones|cuartos?|dormitorios?|sal[óo]n|salas?|apartamentos?|pisos?|caba[ñn]as?|carpas?|caravanas?|autocaravanas?|garajes?|cocheras?|s[óo]tanos?|cobertizos?|trasteros?|furgonetas?|camionetas?|barcos?|ba[ñn]os?|cocinas?|talleres?|graneros?|establos?|refugios?|coches?|carros?|autos?|veh[íi]culos?)${E}`,
            String.raw`${B}(?:garajes?|cocheras?|s[óo]tanos?|cobertizos?|carpas?|caravanas?|autocaravanas?|tienda de campa[ñn]a)${E}(?! (?:de playa))`,
            String.raw`${B}(?:porche|terraza|espacio|lugar|habitaci[óo]n|cuarto|[áa]rea|garaje) (?:cerrad[oa]|sin ventilaci[óo]n)${E}`,
            String.raw`${B}(?:dentro|adentro|aqu[íi] dentro|ah[íi] dentro|bajo techo|en interiores|en un interior)${E}`,
            String.raw`${B}(?:mientras (?:dormimos|duermo|duermen|duermes|los ni[ñn]os duermen|todos duermen)|durante la noche|toda la noche|de madrugada)${E}`,
        ].join("|"),
    ),
    storage: re(String.raw`${B}(?:guardar|guardando|guardad[oa]|almacen\p{L}*|vaciar|drenar|para el invierno|fuera de temporada)${E}`),
    fiction: re(String.raw`${B}(?:novela|mi personaje|gui[óo]n|cuento|ficci[óo]n|hist[óo]ricamente|hist[óo]ric[oa])${E}`),
    running: re(String.raw`${B}(?:usar|usando|encender|encendiendo|encendid[oa]|prender|prendid[oa]|funcionar|funcionando|arrancar|operar|cocinar)${E}`),
    acute: re(
        String.raw`${B}(?:dolor(?:es)? de cabeza|(?:me )?duele la cabeza|mare\p{L}*|n[áa]usea\p{L}*|v[óo]mit\p{L}*|vomit\p{L}*|desmay\p{L}*|inconsciente\p{L}*|confundid\p{L}*|confusi[óo]n|somnolen\p{L}*|dolor (?:en el|de) pecho|falta de aire|no (?:puedo|puede) respirar|no (?:despierta|puede despertar)|dif[íi]cil de despertar|(?:me )?siento (?:mal|rar[oa]|d[ée]bil))${E}` +
            String.raw`|${B}(?:alarmas?|detector(?:es)?|sensor(?:es)?)${E}.{0,60}${B}(?:sonando|son[óo]|suena|pitando|pita|se activ[óo]|se dispar[óo]|marca|muestra|indica|est[áa] encendid[oa])${E}|${B}\d+ ?ppm${E}`,
    ),
    askPermission: re(
        String.raw`(?:^|[.?!¿]\s*)(?:yo |nosotros )?(?:puedo|podemos|se puede|debo|debemos)(?: todav[íi]a| solo| s[óo]lo)? (?:usar|encender|prender|dejar|poner|meter|llevar|traer|cocinar|calentar|operar|mantener|montar|tener)${E}` +
            String.raw`|${B}(?:es|ser[íi]a) (?:seguro|aceptable)${E}|${B}(?:est[áa] bien|hay problema)${E}`,
    ),
    noLeadIf: re(
        String.raw`${B}(?:peligros\p{L}*|peligro|hace da[ñn]o|morir|muere|muerte|mata|matar|envenen\p{L}*|intoxic\p{L}*|riesgo\p{L}*|arriesgad\p{L}*|m[áa]s seguro|preocup\p{L}*|fuera|afuera|al aire libre|patio|jard[íi]n|en vez|en lugar|o|no|lejos|sacar|mover|ventilad\p{L}*|chimenea|instalad\p{L}*|calentador de agua|caldera)${E}`,
    ),
};

// DRAFT translation of the reviewed EN text (native Labs, Oct 18): needs review before it leaves Labs.
export const CO_HAZARD_PT =
  "O monóxido de carbono (CO) de um gerador, de uma churrasqueira a carvão ou a gás, de um fogareiro ou lampião de camping, ou de um aquecedor a combustível que não foi instalado por um profissional com saída para o lado de fora é um veneno que não se vê nem tem cheiro, e pode matar em minutos. " +
  "Nunca use esses aparelhos dentro de casa, garagem, abrigo de carro, porão, depósito, barraca ou trailer, nem com as portas ou janelas abertas: isso não é ventilação suficiente. " +
  "Use o gerador só do lado de fora, a pelo menos 6 metros (20 pés) de qualquer porta, janela ou respiro, com o escapamento virado para longe das construções. " +
  "Nunca deixe um carro ou outro motor ligado na garagem, nem com o portão aberto, e nunca aqueça a casa com o forno ou o fogão a gás. " +
  "Tenha um alarme de CO a pilha, mas um alarme não torna seguro usar esses aparelhos em lugar fechado. " +
  "Se alguém tiver dor de cabeça, tontura, fraqueza, cansaço, náusea, vômito, dor no peito ou confusão, ou desmaiar, leve todos para o ar livre imediatamente, ligue para o serviço de emergência e não volte para dentro até que digam que é seguro.";

export const CO_HAZARD_SOURCES_PT =
  "Fontes (em inglês): CDC, Power Outage and Carbon Monoxide guidance; US CPSC, Portable Generator Hazards and Generators and Engine-Driven Tools; NHS, Carbon monoxide poisoning.";

// DRAFT translation of the reviewed EN text (native Labs, Oct 18): needs review before it leaves Labs.
export const CO_HAZARD_ES =
  "El monóxido de carbono (CO) de un generador, una parrilla de carbón o de gas, una estufa o un farol de camping, o un calentador de combustible que no haya instalado un profesional con salida al exterior es un veneno que no se puede ver ni oler, y puede matar en minutos. " +
  "Nunca los uses dentro de una casa, garaje, cochera, sótano, cobertizo, tienda de campaña o caravana, ni siquiera con las puertas o ventanas abiertas: eso no es ventilación suficiente. " +
  "Usa un generador solo al aire libre, a por lo menos 6 metros (20 pies) de cualquier puerta, ventana o rejilla de ventilación, con el escape apuntando lejos de los edificios. " +
  "Nunca dejes un coche u otro motor encendido en un garaje, ni siquiera con la puerta abierta, y nunca calientes una casa con un horno o una estufa de gas. " +
  "Ten una alarma de CO a pilas, pero una alarma no hace que sea seguro usar estos aparatos en interiores. " +
  "Si alguien tiene dolor de cabeza, mareo, debilidad, cansancio, náuseas, vómitos, dolor en el pecho o confusión, o se desmaya, saca a todos al aire libre de inmediato, llama a los servicios de emergencia y no vuelvas a entrar hasta que te digan que es seguro.";

export const CO_HAZARD_SOURCES_ES =
  "Fuentes (en inglés): CDC, Power Outage and Carbon Monoxide guidance; US CPSC, Portable Generator Hazards and Generators and Engine-Driven Tools; NHS, Carbon monoxide poisoning.";

// The country table has no Spanish lines, so a Spanish answer always ends with this one (DRAFT, as above).
const EMERGENCY_LINE_ES = "En una emergencia, llama al número de emergencias local (911 en EE. UU., 112 en Europa).";

export type CoHazardLanguage = "en" | "pt" | "es";

/** The language of a CO planning question, or null when it is not one. English first (when the question is not Portuguese or
 * Spanish); then the Portuguese and Spanish patterns, whatever the language detectors say ("gerador na garagem fechada" has
 * none of their words). Both match (shared words like "dentro"): the Spanish detector decides. */
export function coHazardLanguage(query: string): CoHazardLanguage | null {
  if (!isPortugueseQuestion(query) && !isSpanishQuestion(query) && isCoHazardQuestion(query)) return "en";
  const pt = wordsHazard(PT, query);
  const es = wordsHazard(ES, query);
  if (pt && es) return isSpanishQuestion(query) ? "es" : "pt";
  return pt ? "pt" : es ? "es" : null;
}

/** The fixed CO answer in the question's language, with its sources and the emergency line. */
export function coHazardAnswer(query: string, language: CoHazardLanguage = "en"): string {
  if (language === "pt") return `${wordsLead(PT, query, "Não. ")}${CO_HAZARD_PT}\n\n${CO_HAZARD_SOURCES_PT}\n\n${emergencyNumbersLine(query, true) ?? emergencyLine(true)}`;
  if (language === "es") return `${wordsLead(ES, query, "No. ")}${CO_HAZARD_ES}\n\n${CO_HAZARD_SOURCES_ES}\n\n${EMERGENCY_LINE_ES}`;
  const q = query.replace(/[’‘]/g, "'");
  const lead = ASK_PERMISSION.test(q) && !NO_LEAD_IF.test(q) && !statedFeet(q).some((d) => d >= 19.5) ? "No. " : "";
  return `${lead}${CO_HAZARD_EN}\n\n${CO_HAZARD_SOURCES_EN}\n\n${emergencyNumbersLine(query, false) ?? emergencyLine(false)}`;
}
