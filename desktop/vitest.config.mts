import { defineConfig } from "vitest/config";

// Desktop unit/integration tests (node:sqlite, local HTTP, symlinks, node-llama-cpp): `npm test` here. They run the
// app's own ../src code on the shims; vitest comes from the repo root's node_modules. e2e/ is Playwright (npm run e2e).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
