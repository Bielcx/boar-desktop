/**
 * The answer model the setup wizard recommends, from the phone's RAM.
 *
 * Measured (eval_scores, 2026-10-02): on a POCO F3 (8 GB, the app reads 7.3 GB) the 1.5B answers
 * at 16-18 tok/s, while 4B-class models (Phi 3.5, Gemma 4B) ran at ~5 tok/s with 3.4-3.9 GB peak
 * memory, one of them finishing 8 of 17 answers. On a POCO X6 Pro (12 GB, reads 10.7 GB) Android
 * closed the backgrounded app holding the 4B (3.1 GB). So the 4B is recommended only from 12 GB
 * phones, which report about 10.7 GB; 8 GB phones get the 1.5B.
 *
 * Stricter than the engine's own default (src/routing/defaultModel.ts, 4B above 4.5 GB): the
 * wizard saves the pick as the active model, so this only decides what a new user starts with.
 */

/** 12 GB phones report about 10.7 GB, 8 GB phones about 7.3 GB. */
export const RECOMMEND_DEFAULT_MIN_RAM_BYTES = 10 * 1024 ** 3;

export interface SetupModelChoice {
  id: string;
  answerTier?: "default" | "compact";
}

/** The recommended model: the default tier on phones with enough RAM, else the compact one. */
export function recommendedAnswerModel<T extends SetupModelChoice>(models: T[], totalRamBytes: number): T | undefined {
  const tier = totalRamBytes >= RECOMMEND_DEFAULT_MIN_RAM_BYTES ? "default" : "compact";
  return models.find((m) => m.answerTier === tier) ?? models[0];
}

/** True when a model is bigger than this phone is recommended for: it may be slow or closed in the background. */
export function heavyForPhone(model: SetupModelChoice, totalRamBytes: number): boolean {
  return model.answerTier === "default" && totalRamBytes > 0 && totalRamBytes < RECOMMEND_DEFAULT_MIN_RAM_BYTES;
}

/** The model to download: the user's pick, else one already on the phone, else the recommended one. */
export function answerModelToInstall<T extends SetupModelChoice>(
  models: T[],
  presence: Record<string, boolean>,
  totalRamBytes: number,
  chosenId?: string
): T | undefined {
  return (
    models.find((m) => m.id === chosenId) ?? models.find((m) => presence[m.id]) ?? recommendedAnswerModel(models, totalRamBytes)
  );
}
