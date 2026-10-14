# Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on Windows, from a tag.

1. Bump `version` in `desktop/package.json` (e.g. `0.2.0`) and commit it on `main`.
2. Tag that commit with the same version and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The workflow checks the tag matches `desktop/package.json`, runs `npm run dist` and opens a **draft** release
   with `BOAR-Setup-0.2.0.exe` and notes generated from the merged pull requests.
4. Open the draft on GitHub, edit the notes, try the installer, and press **Publish**.

To build the same installer locally: `cd desktop && npm run dist`
(see `desktop/docs/05-pacote.md`).

## Before the first public release

- **`appId`** (`desktop/package.json` → `build.appId`) is Windows' identity for the app (shortcuts, notifications,
  updates). Settle it before publishing: changing it later makes Windows treat the new version as another program.
- **Code signing.** The installer is unsigned, so SmartScreen warns on download. With a code-signing certificate,
  add the `CSC_LINK` and `CSC_KEY_PASSWORD` secrets and pass them to the `npm run dist` step.
