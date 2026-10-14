/**
 * What the boar is doing right now, from what the chat already knows. Pure, so it is unit-tested; the
 * animation for each mood is in BoarBuddy.tsx.
 */
import type { ProcessingStatus } from "../ProcessingIndicator";

export type Mood = "idle" | "listening" | "searching" | "thinking" | "answering" | "speaking" | "notfound";

export interface MoodInput {
  /** The microphone is recording. */
  listening: boolean;
  /** An answer is being read aloud. */
  speaking: boolean;
  /** The chat's own progress for the answer being written (null when none is). */
  processing: ProcessingStatus | null;
  /** The last finished answer came back with no source. */
  lastAnswerHadNoSource: boolean;
}

export function moodFor(i: MoodInput): Mood {
  if (i.listening) return "listening";
  if (i.processing === "retrieving") return "searching";
  if (i.processing === "thinking") return "thinking";
  if (i.processing === "generating") return "answering";
  if (i.speaking) return "speaking";
  if (i.lastAnswerHadNoSource) return "notfound";
  return "idle";
}
