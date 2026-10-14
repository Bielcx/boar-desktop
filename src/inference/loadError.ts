/**
 * A failed model load, with its cause as data (Harbor/Quill, iOS dc63525): the
 * RAM hint appended to the message made the chat call every failure "not
 * enough memory", including a Metal backend failure. The UI reads `kind`;
 * `native` is llama.rn's own message and `hint` the RAM estimate, kept apart.
 */
export type LoadFailureKind = "memory" | "engine" | "corrupt" | "missing";

export class ModelLoadError extends Error {
  readonly code = "load_failed" as const;
  constructor(
    message: string,
    readonly kind: LoadFailureKind,
    readonly native: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ModelLoadError";
  }
}

const MEMORY = /out of memory|\boom\b|cannot allocate|failed to allocate|alloc(ation)? failed|enomem|insufficient memory|not enough memory/i;
const CORRUPT = /invalid magic|bad magic|not a gguf|unknown (model )?architecture|failed to read|unexpected end|truncat|corrupt|tensor .* (not found|missing|size)|invalid (file|model)/i;

/**
 * The cause from llama.rn's message and the pre-load fit. A thrashing fit
 * with a terse native message ("Failed to load model") is memory; a model that
 * fits is the engine (Metal/backend), which the RAM hint must not mask.
 */
export function classifyLoadFailure(native: string, fitVerdict?: string | null): LoadFailureKind {
  if (CORRUPT.test(native)) return "corrupt";
  if (MEMORY.test(native)) return "memory";
  if (fitVerdict === "insufficient" || fitVerdict === "thrashing") return "memory";
  return "engine";
}
