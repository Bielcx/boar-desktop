# Building and developing BOAR

TL;DR: `make setup` walks you through install, build and dev mode. Manual commands for Android below.

## Quickstart


```bash
git clone https://github.com/rferrari/boar-app.git
cd boar-app
npm install

# Build via EAS (no local Android SDK needed) — see eas.json
npx eas-cli build --platform android --profile preview

# OR build locally if you have the Android SDK set up:
npx expo prebuild -p android --clean
npx expo run:android
```

### Guided setup

The easiest way: clone the repo and run the setup wizard, which asks what you
want and walks you through it.

```bash
git clone https://github.com/rferrari/boar-app.git
cd boar-app
make setup         # or: node scripts/setup.mjs
```

It offers:

1. **Install BOAR on my phone:** downloads the latest release APK (checksum
   verified) and installs it over a USB cable, or tells you how to copy it over.
2. **Build the app from source:** checks Node, JDK and the Android SDK and tells
   you exactly what's missing, then builds in the cloud with EAS (no Android SDK
   needed) or locally, and can install the APK over USB.
3. **Developer mode (advanced):** a live-reloading development build over USB.
4. **Build a bigger offline knowledge pack** (optional, see
   [docs/KNOWLEDGE_PACKS.md](KNOWLEDGE_PACKS.md)).

The individual steps are also `make` targets (`make help` lists them):
`make install` (npm dependencies), `make run-android` (local build, needs the
Android SDK), `make build-eas` (cloud build).

On first launch, the app shows a one-time setup screen that downloads the
answer model plus a small embedding model (see `docs/MODELS.md`): builds from
`main` default to Qwen3-4B (about 2.5 GB in all), the v1.0.0 APK to Qwen2.5-1.5B
(about 1 GB). That is the only time it needs network access. From
then on it works fully offline, airplane mode included.
An in-app "Models" screen lets you optionally download additional/alternate
models later when you do have connectivity — see
`src/ui/ModelSetupScreen.tsx`, the only place in the app that touches the
network.

## iOS

The iPhone app and its build guide live on the [`ios_android`](https://github.com/rferrari/boar-app/tree/ios_android) branch, which builds both platforms. `main` is Android only.

## Development


```bash
npm install
npx expo prebuild -p android --clean   # regenerates ./android (gitignored) from app.json
npx expo run:android                   # build + launch on a connected device
```

`--clean` matters any time `app.json`/assets change (app name, icon, plugins): without it,
prebuild can leave a stale `android/` project around with the old values baked in — that's
what a plain `npm install` alone will never fix, since it never touches `android/` at all.

### Testing result sharing

Evaluation › Share results only works from a release build signed with BOAR's release key:
the server checks the phone's hardware-key attestation, and development builds (signed with
Expo's public debug key) are refused. Build and install a release APK:

```bash
make apk-downloader                                  # dist/boar-downloader-<version>-arm64.apk
adb install dist/boar-downloader-<version>-arm64.apk # application id team.sopa.aoair
```

A development build made from this repo has the same application id but a different signing
key, so Android won't install one over the other: uninstall the development build first, which
deletes its downloaded models (copy them out and import them from files to avoid downloading
them again).
The share flow, limits and moderation: [RESULTS_SCORE.md](RESULTS_SCORE.md#how-a-share-works)
and [supabase/README.md](../supabase/README.md).

### Blank/white screen or "Failed to connect to \<LAN IP\>" after `make start`

This is a Wi-Fi network problem, not a build problem: some routers (and most phone
hotspots) enable **client/AP isolation**, which silently blocks the phone and this
computer from reaching each other even on the same Wi-Fi network and subnet. The dev
client keeps retrying your computer's LAN IP and timing out. USB debugging isn't
affected — fix it by forcing Metro onto the USB `adb reverse` tunnel instead of Wi-Fi:

```bash
npx expo start --localhost
```

Then reopen the app; if it still shows the old server list, use its "Enter URL
manually" field with `http://127.0.0.1:8081`.

