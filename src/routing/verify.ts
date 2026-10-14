/** Evidence-grounded verification prompt and verdict parsing (pure; used by executor.ts and answer.ts). */
import type { RetrievedChunk } from "../rag/retrieve.types";
import type { VerificationStatus } from "./types";

/**
 * Task-specific per the build plan ("should not simply ask another model
 * whether the first model was correct") — this asks whether the answer's
 * claims are actually supported by the retrieved evidence, a narrower and
 * more checkable question than open-ended correctness.
 */
export const VERIFICATION_INSTRUCTION =
  `You are checking whether an answer is actually supported by the evidence below — ` +
  `not whether it's well-written, not whether you personally agree with it. ` +
  `Respond with exactly one word first: SUPPORTED, PARTIAL, or UNSUPPORTED, then a ` +
  `single sentence explaining why.`;

export function buildVerificationInput(query: string, answer: string, citations: RetrievedChunk[]): string {
  const evidence = citations.map((c, i) => `[${i + 1}] ${c.title}\n${c.body}`).join("\n\n");
  return `Question: ${query}\n\nEvidence:\n${evidence}\n\nAnswer to check:\n${answer}`;
}

/** Plain-prompt form (models without a chat template); see taskRequest in src/inference/format.ts. */
export function buildVerificationPrompt(query: string, answer: string, citations: RetrievedChunk[]): string {
  return `${VERIFICATION_INSTRUCTION}\n\n${buildVerificationInput(query, answer, citations)}\n\nVerdict:`;
}

export function parseVerificationVerdict(text: string): { status: VerificationStatus; note?: string } {
  const upper = text.trim().toUpperCase();
  const note = text.trim().slice(0, 200) || undefined;
  if (upper.startsWith("SUPPORTED")) return { status: "passed", note };
  if (upper.startsWith("UNSUPPORTED")) return { status: "failed", note };
  if (upper.startsWith("PARTIAL")) return { status: "uncertain", note };
  // The verifier didn't follow the requested format — genuinely uncertain,
  // not a crash: we asked for a specific answer shape and didn't get one.
  return { status: "uncertain", note };
}
