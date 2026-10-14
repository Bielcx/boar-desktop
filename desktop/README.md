# BOAR desktop

The Android app's UI and engine, unchanged, running in Electron on Windows, macOS and Linux.

## How it works

- **Renderer** = the Expo **web** build of the app (`index.ts` at the repo root), bundled with
  `BOAR_TARGET=desktop`. With that variable, `metro.config.js` resolves each native package
  (`llama.rn`, `expo-sqlite`, `expo-file-system`, `ram-monitor`, …) to `src/shims/<pkg>.ts`. The list of packages
  lives in one place, `src/shared/packages.json` (Metro, preload and `handlers/index.ts` all follow it).
- **Shims** implement only the API subset the app uses and call `window.boarNative`
  (`src/shared/bridge.ts`): `invoke("<pkg>:<method>", …)`, `on(...)`, `platform`, `dirs`, `ram`.
- **Preload** (`src/main/preload.ts`) exposes `boarNative` and nothing else; only `<pkg>:<method>`
  channels of known packages pass. `dirs`, a first RAM reading and the package list arrive as a process argument,
  so they're there before the page runs.
- **Main** (`src/main/main.ts`) opens the window (contextIsolation, sandbox, no nodeIntegration),
  creates `<userData>/documents` and `<userData>/app-cache`, and registers `src/main/handlers/<pkg>.ts`
  (node-llama-cpp, node:sqlite, fs, dialogs…). Every path from the renderer must be inside one of those two
  folders (`src/main/storage/safePath.ts`), and IPC is only served to the app's own main frame.
- Dev loads the Expo dev server (`http://localhost:8081`); prod serves `web-dist/` through `app://boar/`
  (the export uses absolute `/_expo/...` paths, which `file://` can't serve), with a Content-Security-Policy
  (dev has none: Metro's bundle needs eval). Navigation away from the app is blocked; http(s) links open in the
  system browser. All permission requests are denied except clipboard writes and the microphone (audio only, app page only: voice input). One instance at a time.
  Security notes: `docs/06-seguranca.md`.
- **MCP server** (off by default, Settings > Share my library): other AI apps search the library read-only over stdio,
  running `BOAR.exe` as Node (`ELECTRON_RUN_AS_NODE=1`) on `dist/mcp/server.js` (`src/mcp/`, bundled by
  `scripts/build-mcp.mjs` in `build:main`). Notes: `docs/09-mcp.md`.

## Scripts (run in `desktop/`)

| | |
|---|---|
| `npm install` | Electron + TypeScript (only here; the repo root has its own install) |
| `npm run dev` | Expo dev server with `BOAR_TARGET=desktop` + compile main + Electron on it |
| `npm run build:web` | `expo export --platform web` → `desktop/web-dist/` |
| `npm start` | compile main + Electron on `web-dist/` (run `build:web` first) |
| `npm run typecheck` | main/preload (`tsconfig.json`) and shims (`tsconfig.shims.json`) |
| `npm test` | vitest on `test/` (shims against the real handlers, the app's engine code on them, the guards). `BOAR_TEST_MODELS_DIR` also runs `test/llama.rn.test.ts`'s model tests. The repo root's `npx vitest` skips `desktop/` |
| `npm run dist` | the Electron binary (`install-electron`, once) + `build:main` + `build:web` + electron-builder → `release/BOAR-Setup-<ver>.exe` (NSIS, per-user, unsigned) and `release/win-unpacked/` (see `docs/05-pacote.md`) |
| `npm run e2e` | Playwright drives the built app, 6 specs: `chat` (setup → cited answer, Alert/Share), `persistence` (state survives a restart), `documents` (import a note and a PDF, get both cited; a locked PDF fails clearly; export/remove), `tour` (every screen, no errors), `voice` (fake microphone -> whisper -> chat input; also needs `ggml-base-q5_1.bin` there), `folder-watch` (a .txt dropped in a watched folder gets imported, announced and cited). Needs `build:web` and `BOAR_TEST_MODELS_DIR` |

`BOAR_E2E_EXE=release/win-unpacked/BOAR.exe` (after `npm run dist`) runs the e2e specs on the packaged app.
`BOAR_USER_DATA=<dir>` runs the app on another data folder instead of `%APPDATA%\BOAR` (the e2e test uses a
fresh temp one per run). `BOAR_SCREENSHOT=<file.png>` (optionally `BOAR_SCREENSHOT_DELAY_MS`) makes the app save a capture of
its window after load and quit: a smoke check without clicking.

Main-side code uses erasable TypeScript only (no enums, namespaces, parameter properties), so tests
can run it with plain `node file.ts`.

## Layout

```
desktop/
  scripts/run.mjs        dev / build-web launcher (sets BOAR_TARGET, no cross-env)
  src/shared/bridge.ts   the BoarNative contract
  src/shared/packages.json  the packages the shims replace (module name -> shim/handler/channel name)
  src/shims/<pkg>.ts     renderer side, bundled by Metro
  src/main/main.ts       window, app:// protocol, HandlerContext
  src/main/preload.ts    window.boarNative
  src/main/handlers/     one file per package, register(ctx)
  src/testing/loopback.ts  in-process IPC for shim tests
  test/                  vitest (npm test)
  e2e/                   Playwright (npm run e2e)
  src/mcp/               MCP server (protocol.ts, server.ts), bundled to dist/mcp/server.js
  docs/                  notes in pt-BR: 01-casca … 05-pacote, 06-seguranca, 07-voz, 08-javali-e-voz (mascot, read aloud, watched folders + tray), 09-mcp, 10-api
  dist/                  tsc output (main + preload)
  web-dist/              expo export output
  release/               electron-builder output (npm run dist)
```

`Alert.alert` and `Share.share` from react-native-web don't work in Electron (a no-op and a missing
`navigator.share`): Metro swaps them for `src/shims/rn-alert.ts` (native alert/confirm boxes) and
`src/shims/rn-share.ts` (copy to clipboard).

Location, device keys and bundled assets report "unavailable" on desktop; the app already handles that. Voice
input works offline with whisper.cpp (`docs/07-voz.md`): the app's `requireOptionalNativeModule("VoiceInput")` gets
`src/shims/voice-input.ts` through `src/shims/expo-modules-core.ts` (Metro maps that import for files under the repo's
`src/` only), which records with getUserMedia and transcribes in main (`handlers/voice-input.ts`,
`@fugood/whisper.node`, CPU). The model (`ggml-base-q5_1.bin`, 60 MB) is downloaded on the first tap, after a confirm.
Watched folders (Settings, off by default; `docs/08-javali-e-voz.md`): main watches folders picked in its own dialog
(`handlers/folder-watch.ts`, `src/main/watch.ts`), copies new or changed files into `<userData>/app-cache/FolderWatch/`
and the page imports them through the "FolderWatch" module (`shims/folder-watch.ts`); a tray icon and a system
notification come with it. Sharing becomes a save dialog; the document picker copies the picked files into
`<userData>/app-cache/DocumentPicker/<uuid>-<name>` so the file-system shim can read them. PDF text comes from
pdf.js (`pdfjs-dist`, legacy build) in a worker thread of main (`handlers/expo-pdf-text-extract.ts`).
