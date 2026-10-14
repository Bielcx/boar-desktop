/**
 * Rough RAM-fit estimate for a GGUF model on this device — shared between
 * the catalog UI (CatalogItemCard) and the routing layer's ModelProfile
 * resolution, so both use the same formula rather than drifting apart.
 * Heuristic, not a measurement: a GGUF model's resident working set while
 * loaded (weights actually touched via mmap + KV cache) tracks close to its
 * file size for a fully-resident quantized model, plus some overhead for
 * context/KV cache — 1.15x is a conservative approximation.
 */
export type Compatibility = "green" | "yellow" | "red" | "unknown";

export function computeCompatibility(sizeBytes: number, deviceRamBytes: number): Compatibility {
  if (deviceRamBytes <= 0) return "unknown";
  const estimatedRamBytes = sizeBytes * 1.15;
  if (estimatedRamBytes <= deviceRamBytes * 0.65) return "green";
  if (estimatedRamBytes <= deviceRamBytes * 0.9) return "yellow";
  return "red";
}
