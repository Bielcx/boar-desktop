import { defineConfig } from "vitest/config";

// The benchmark (npm run bench): one long "test" that runs the app's engine and writes a JSON result. Kept out of
// npm test (test/**). Flags and env: bench/run.mjs.
export default defineConfig({
  test: {
    include: [process.env.BOAR_BENCH_DOCS ? "bench/docs.run.ts" : "bench/engine.run.ts"],
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
  },
});
