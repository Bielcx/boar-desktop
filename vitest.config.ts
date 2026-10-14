import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Edge Functions run on Deno and have their own tests (deno test, see supabase/README.md).
    // desktop/ (Electron) has its own suites: cd desktop && npm test (vitest) and npm run e2e (Playwright).
    exclude: [...configDefaults.exclude, "supabase/functions/**", "desktop/**"],
  },
});
