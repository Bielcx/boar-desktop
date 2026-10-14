/**
 * One rule for every instruction-style call (verification, titles,
 * summaries, multi-pass research stages): when the loaded GGUF ships a chat
 * template, send role messages and let llama.cpp render them with the model's
 * own template (llama.rn completion({ messages, jinja: true })); only a model
 * without a template gets a hand-built prompt ending in a cue like "Verdict:".
 *
 * Off-template prompts are how instruct models end up emitting EOS at once or
 * rambling: their fine-tuning never saw "Question:/Answer:" framing. The
 * evaluation runner renders the same way (llama-server --jinja), so app and
 * eval measure the same thing.
 */
import type { ChatMessageInput } from "./LlamaEngine";

export interface TaskRequest {
  prompt?: string;
  messages?: ChatMessageInput[];
}

export function taskRequest(instruction: string, input: string, cue: string, hasTemplate: boolean): TaskRequest {
  if (hasTemplate) {
    return {
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: input },
      ],
    };
  }
  return { prompt: `${instruction}\n\n${input}\n\n${cue}` };
}
