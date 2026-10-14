/**
 * Loads a llama.rn context, falling back to CPU once when the GPU backend
 * fails to start. iPhone 13 (integration 90b87dd): llama.rn compiles its
 * Metal shaders at runtime and the flash-attention library dies with
 * XPC_ERROR_CONNECTION_INTERRUPTED -> "failed to initialize MTL0 backend",
 * so initLlama rejects even with n_gpu_layers: 0. Pure (no llama.rn import):
 * LlamaEngine and the embedding engine pass initLlama in.
 */

export interface BackendInitParams {
  n_gpu_layers?: number;
  devices?: string[];
  flash_attn_type?: "auto" | "on" | "off";
}

export interface BackendInfo {
  /** "default": the first attempt worked; "cpu-fallback": the retry on CPU only did. */
  kind: "default" | "cpu-fallback";
  /** Native message of the failed first attempt. */
  reason?: string;
}

/**
 * Errors that a CPU-only retry can fix: GPU/Metal backend start-up, or llama.cpp's terse context failure.
 * llama.rn's JSI init (cpp/jsi/RNLlamaJSI.cpp) rejects with only "Failed to load model"; the Metal
 * details go to the native log. A missing file is caught before initLlama, so a corrupt file is
 * the only other cause, and it costs one extra CPU attempt that surfaces the same error.
 */
export const BACKEND_INIT_ERROR = /metal|\bmtl\d*\b|\bgpu\b|backend|xpc_error|flash.?attn|failed to initialize context|failed to load model/i;

/** CPU device names from getBackendDevicesInfo(); ["CPU"] (ggml's name) when they can't be read. */
export async function cpuDeviceNames(
  info: () => Promise<Array<{ backend: string; type: string; deviceName: string }>>
): Promise<string[]> {
  try {
    const names = (await info()).filter((d) => /cpu/i.test(d.type) || /cpu/i.test(d.backend)).map((d) => d.deviceName);
    return names.length ? names : ["CPU"];
  } catch {
    return ["CPU"];
  }
}

export async function initWithCpuFallback<P extends object, C>(
  init: (params: P & BackendInitParams) => Promise<C>,
  params: P & BackendInitParams,
  opts: { platform: string; cpuDevices: () => Promise<string[]>; log?: (message: string) => void }
): Promise<{ context: C; backend: BackendInfo }> {
  // iOS: the library that fails to compile is the flash-attention one; don't ask for it.
  const first: P & BackendInitParams = opts.platform === "ios" ? { ...params, flash_attn_type: "off" } : params;
  try {
    return { context: await init(first), backend: { kind: "default" } };
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    if (!BACKEND_INIT_ERROR.test(reason)) throw e;
    opts.log?.(`[engine] backend init failed (${reason}); retrying on CPU only`);
    const cpu = { ...params, n_gpu_layers: 0, devices: await opts.cpuDevices(), flash_attn_type: "off" as const };
    return { context: await init(cpu), backend: { kind: "cpu-fallback", reason } };
  }
}
