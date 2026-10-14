Attestation chains from real phones, copied from Google's
[android/keyattestation](https://github.com/android/keyattestation/tree/main/testdata)
test data (Apache License 2.0). Both apps' signing certificate digest is `103938ee4537e59e8ee792f654504fb8346fc6b346d0bbc4415fc339fcfc8ec1`.

- `pixel8a-tee-ec.chain`: Pixel 8a (akita), Android 14, TEE, unlocked bootloader. App
  `com.google.wireless.android.security.attestationverifier.collector`, challenge `challenge`.
- `pixel9a-strongbox-2026-root.chain`: Pixel 9a (tegu), Android 16, StrongBox, locked,
  chaining to Google's 2025 EC root. App
  `com.google.android.attestation`, challenge `90578e1d-f5bf-4ccf-a27f-a4f4d89ee21f`.

They're `.chain` files, not `.pem`, because the repo ignores `*.pem` to keep keys out of git;
these hold only public certificates.
