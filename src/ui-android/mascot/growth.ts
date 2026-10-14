/**
 * The boar grows with the knowledge the user installs: every pack file in documents/corpus/ (a bigger
 * bundled corpus, a Wikipedia pack, a format-1 pack) counts as one. The thresholds live in STAGES; the art
 * for each stage lives in art.ts, so restyling never touches this file.
 */
import * as FileSystem from "expo-file-system/legacy";

export type GrowthStage = "filhote" | "jovem" | "adulto" | "anciao";

/** In order; a stage starts at minPacks. */
export const STAGES: ReadonlyArray<{ id: GrowthStage; minPacks: number }> = [
  { id: "filhote", minPacks: 0 },
  { id: "jovem", minPacks: 1 },
  { id: "adulto", minPacks: 3 },
  { id: "anciao", minPacks: 6 },
];

export function stageFor(packs: number): GrowthStage {
  let stage = STAGES[0].id;
  for (const s of STAGES) if (packs >= s.minPacks) stage = s.id;
  return stage;
}

/** Packs the next stage needs, or null at the last one. */
export function packsToNextStage(packs: number): number | null {
  const next = STAGES.find((s) => s.minPacks > packs);
  return next ? next.minPacks - packs : null;
}

const PACK_FILE = /\.(sqlite|json)$/i;

export async function countKnowledgePacks(): Promise<number> {
  const names = await FileSystem.readDirectoryAsync(`${FileSystem.documentDirectory}corpus/`).catch(() => [] as string[]);
  return names.filter((n) => PACK_FILE.test(n)).length;
}
