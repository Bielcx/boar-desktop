/**
 * The answer model the setup wizard recommends, from the computer's RAM.
 *
 * On a PC the 4B is the better pick from 8 GB: in the desktop benchmark (bench --full, GTX 1650, Oct 2026) Qwen3-4B
 * got 0.83 of the facts right with no false declines, Qwen2.5-1.5B 0.44 with 4 of 16 questions declined, at 28 vs 62
 * tok/s. A PC doesn't close an app in the background as Android does, and the 4B needs about 3.3 GB with its context,
 * which an 8 GB computer (Windows reports about 7.8 GB) has. The phone rule below is kept for the record.
 *
 * The native app's phone rule:
 * Measured (eval_scores, 2026-10-02): on a POCO F3 (8 GB, the app reads 7.3 GB) the 1.5B answers
 * at 16-18 tok/s, while 4B-class models (Phi 3.5, Gemma 4B) ran at ~5 tok/s with 3.4-3.9 GB peak
 * memory, one of them finishing 8 of 17 answers. On a POCO X6 Pro (12 GB, reads 10.7 GB) Android
 * closed the backgrounded app holding the 4B (3.1 GB). So the 4B is recommended only from 12 GB
 * phones, which report about 10.7 GB; 8 GB phones get the 1.5B.
 *
 * Stricter than the engine's own default (src/routing/defaultModel.ts, 4B above 4.5 GB): the
 * wizard saves the pick as the active model, so this only decides what a new user starts with.
 */

/** 8 GB computers report about 7.4-7.8 GB (some is kept for integrated graphics); 6 GB ones about 5.9. */
export const RECOMMEND_DEFAULT_MIN_RAM_BYTES = 7 * 1024 ** 3;

export interface SetupModelChoice {
  id: string;
  answerTier?: "default" | "compact";
}

/** The recommended model: the default tier on computers with enough RAM, else the compact one. */
export function recommendedAnswerModel<T extends SetupModelChoice>(models: T[], totalRamBytes: number): T | undefined {
  const tier = totalRamBytes >= RECOMMEND_DEFAULT_MIN_RAM_BYTES ? "default" : "compact";
  return models.find((m) => m.answerTier === tier) ?? models[0];
}

/** True when a model is bigger than this computer is recommended for: it may be slow and use most of the memory. */
export function heavyForComputer(model: SetupModelChoice, totalRamBytes: number): boolean {
  return model.answerTier === "default" && totalRamBytes > 0 && totalRamBytes < RECOMMEND_DEFAULT_MIN_RAM_BYTES;
}

/** The model to download: the user's pick, else one already on the computer, else the recommended one. */
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
