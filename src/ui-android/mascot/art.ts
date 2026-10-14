/**
 * The boar's art, one image per growth stage (growth.ts). To restyle a stage, replace its PNG in
 * assets/mascot/ (square, transparent background, the boar standing on the bottom edge); no code changes.
 *
 * A stage may also get its own image per mood (e.g. a sleepy one for "notfound"): add it under `moods`.
 * Moods without their own image use the stage image with the animation from BoarBuddy.tsx.
 */
import type { ImageSourcePropType } from "react-native";
import type { GrowthStage } from "./growth";
import type { Mood } from "./mood";

export interface StageArt {
  image: ImageSourcePropType;
  moods?: Partial<Record<Mood, ImageSourcePropType>>;
}

export const MASCOT_ART: Record<GrowthStage, StageArt> = {
  filhote: { image: require("../../../assets/mascot/filhote.png") },
  jovem: { image: require("../../../assets/mascot/jovem.png") },
  adulto: { image: require("../../../assets/mascot/adulto.png") },
  anciao: { image: require("../../../assets/mascot/anciao.png") },
};

export function artFor(stage: GrowthStage, mood: Mood): ImageSourcePropType {
  const art = MASCOT_ART[stage];
  return art.moods?.[mood] ?? art.image;
}
