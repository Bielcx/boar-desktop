# AGENTS.md — building BOAR desktop from source

For what the app is, read `README.md` and `desktop/README.md` first; this file only covers build mechanics.

## Two installs, one app

The repo root is the app (Expo/React Native code in `src/`); `desktop/` is Electron. The desktop renderer is
the Expo **web** export of the root, built with `BOAR_TARGET=desktop` so `metro.config.js` resolves each native
package to `desktop/src/shims/<pkg>.ts`. Both folders need their own `npm install`.

```bash
npm install
cd desktop && npm install
npm run dev        # Expo dev server + Electron
npm run dist       # build:main + build:web + electron-builder -> desktop/release/
```

On Windows, run `npm install` at the root from PowerShell or cmd, not Git Bash: `llama.rn`'s postinstall
extracts a tarball with `tar`, and Git Bash's `tar` reads `C:\...` as a remote host and fails.

## Verifying without packaging

```bash
npm run typecheck && npm test                 # root: the app's TypeScript and unit tests
cd desktop && npm run typecheck && npm test   # main process, shims, handlers
npm run e2e                                   # Playwright on the built app (needs build:web, BOAR_TEST_MODELS_DIR)
```

On Windows two root tests fail for environment reasons, not code: `networkAudit.test.ts` compares `/` paths
(Windows gives `\`), and `poiPack.test.ts` needs `bzip2` on PATH. CI runs the root on Linux, `desktop/` on Windows.

## Before pushing: CodeRabbit review

```bash
cr doctor                          # once: CLI installed and signed in
cr review --agent --base main      # this branch against main, structured findings
```

A review can take several minutes, so run it in the background. Check each finding against the current code:
fix the ones that hold up, note in one line why you skipped the others. Re-run once after fixing, not in a loop.

## Building a knowledge pack

Full guide: [docs/KNOWLEDGE_PACKS.md](docs/KNOWLEDGE_PACKS.md).

```bash
npm run pack:build -- --limit 200 --id test-pack   # quick check that the pipeline works
npm run pack:build                                 # the full Vital Articles level 5 pack
```

Packs must be embedded with the app's model (`assets/models/embedding.gguf`, checked by SHA-256). Don't commit
`.sqlite` packs to git; they go to a release asset.

## Common pitfalls

- **Release folders in git**: `desktop/release/` and `desktop/release-next/` hold the installer (>100 MB,
  GitHub rejects it). Both are ignored; keep it that way.
