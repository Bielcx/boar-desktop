# Security

## Reporting a vulnerability

Please report it privately: [open a security advisory](https://github.com/Bielcx/boar-desktop/security/advisories/new)
on this repository. Don't open a public issue. You'll get an answer within a week, and credit in the release notes
if you'd like it.

Useful to include: the BOAR version (Settings > About & Info), what an attacker needs (a file the user imports, a web
page, another program on the same computer...), and the steps to reproduce.

## Supported versions

Only the latest release gets fixes. The download link always serves it:
https://github.com/Bielcx/boar-desktop/releases/latest/download/BOAR-Setup.exe

## Checking a download

Every installer is built by GitHub Actions from a tagged commit and has a signed provenance attestation:

```bash
gh attestation verify BOAR-Setup.exe --repo Bielcx/boar-desktop
```

`SHA256SUMS.txt` in each release has the installers' SHA-256 (PowerShell: `Get-FileHash BOAR-Setup.exe`).

## What the app does to stay safe

The design and each protection (sandboxed window, IPC limited to the app's own page, files confined to BOAR's
folders, https-only downloads checked by SHA-256, the local API and MCP server off by default) are described in
[desktop/docs/06-seguranca.md](desktop/docs/06-seguranca.md) (Portuguese).
