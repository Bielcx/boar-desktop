// deno test --no-config --node-modules-dir=none supabase/functions/submit-results/
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { AttestError, b64encode, verifyAndroid, verifyAndroidSignature } from "./attest.ts";
import { parsePayload } from "./payload.ts";

const chainOf = (file: string) =>
  [...Deno.readTextFileSync(new URL(`./testdata/${file}`, import.meta.url)).matchAll(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g,
  )].map((m) => m[1].replace(/\s/g, ""));
const PIXEL8A = chainOf("pixel8a-tee-ec.chain");
const PIXEL9A = chainOf("pixel9a-strongbox-2026-root.chain");
const expect = {
  packageName: "com.google.wireless.android.security.attestationverifier.collector",
  certDigests: ["103938ee4537e59e8ee792f654504fb8346fc6b346d0bbc4415fc339fcfc8ec1"],
  checkRevocation: false, // offline; the function always checks Google's list
};

Deno.test("a real phone's key is accepted, on either Google root", async () => {
  const a = await verifyAndroid(PIXEL8A, "challenge", expect);
  assertEquals(a.info.securityLevel, "tee");
  assertEquals(a.info.verifiedBootState, "unverified"); // unlocked phones may share too
  const b = await verifyAndroid(PIXEL9A, "90578e1d-f5bf-4ccf-a27f-a4f4d89ee21f", {
    ...expect,
    packageName: "com.google.android.attestation",
  });
  assertEquals(b.info.securityLevel, "strongbox");
  assertEquals(b.info.deviceLocked, true);
});

Deno.test("another challenge, app or signing key is refused", async () => {
  await assertRejects(() => verifyAndroid(PIXEL8A, "replayed", expect), AttestError, "wrong challenge");
  await assertRejects(
    () => verifyAndroid(PIXEL8A, "challenge", { ...expect, packageName: "team.sopa.aoair" }),
    AttestError,
    "another app",
  );
  await assertRejects(
    () => verifyAndroid(PIXEL8A, "challenge", { ...expect, certDigests: ["00".repeat(32)] }),
    AttestError,
    "release key",
  );
});

Deno.test("a chain that doesn't reach Google's root is refused", async () => {
  await assertRejects(() => verifyAndroid(PIXEL8A.slice(0, -1).slice(0, 2), "challenge", expect), AttestError);
  // One phone's leaf on the other phone's intermediates.
  await assertRejects(() => verifyAndroid([PIXEL8A[0], ...PIXEL9A.slice(1)], "challenge", expect), AttestError, "chain");
  await assertRejects(() => verifyAndroid([PIXEL8A[0]], "challenge", expect), AttestError);
  await assertRejects(() => verifyAndroid(["bm90IGEgY2VydA=="], "challenge", expect), AttestError);
});

/** WebCrypto signs as r || s; the Keystore gives DER, like this. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return v[0] & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

Deno.test("the signature must cover exactly the challenge and payload", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const message = 'abc.{"run":{}}';
  for (let i = 0; i < 20; i++) { // covers r and s with and without a leading 0x00
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(message)));
    const sig = b64encode(rawToDer(raw));
    assert(await verifyAndroidSignature(spki, sig, message));
    assert(!(await verifyAndroidSignature(spki, sig, message + " ")));
  }
  assert(!(await verifyAndroidSignature(spki, "AAAA", message)));
  // Truncated DER: the length bytes promise more than there is.
  assert(!(await verifyAndroidSignature(spki, b64encode(new Uint8Array([0x30, 0x44, 0x02, 0x20, 1, 2, 3])), message)));
});

Deno.test("the payload's platform must be the attested one", () => {
  const payload = JSON.stringify({
    run: { runId: "r", evalSetVersion: "1", appVersion: "1.0.0", platform: "ios", cpuFeatures: [] },
    rows: [{ queryId: "factual-1", configId: "m", outcome: "success", tokPerSec: 1e9, ttftMs: -5 }],
  });
  assertEquals(parsePayload(payload, "android"), { error: "run.platform doesn't match the device" });
  const ok = parsePayload(payload, "ios");
  assert(!("error" in ok));
  assertEquals(ok.rows[0].tok_per_sec, null); // absurd numbers are dropped, not stored
  assertEquals(ok.rows[0].ttft_ms, null);
  // No CPU flags (iOS) is unknown, stored as null, so the scores don't claim "no dotprod".
  assertEquals(ok.run.cpu_features, null);
  const android = parsePayload(JSON.stringify({ run: { runId: "r", evalSetVersion: "1", appVersion: "1", platform: "android", cpuFeatures: ["asimddp", "BAD FLAG"] }, rows: [{ queryId: "q", configId: "m", outcome: "success" }] }), "android");
  assert(!("error" in android));
  assertEquals(android.run.cpu_features, ["asimddp"]);
});

Deno.test("a row keeps only the known fields, each checked", () => {
  const parsed = parsePayload(
    JSON.stringify({
      run: { runId: "r", evalSetVersion: "1", appVersion: "1.0.0", platform: "android" },
      rows: [{
        queryId: "factual-1",
        configId: "model:qwen",
        outcome: "success",
        configLabel: "Qwen2.5-1.5B-Instruct (Q4_K_M)",
        answer: "x".repeat(10_000),
        query: "the question text, which the server already has",
        retrievedTitles: ["Black hole", 42, "y".repeat(500)],
        modelResidency: "somewhere",
        extra: "z".repeat(100_000),
      }],
    }),
    "android",
  );
  assert(!("error" in parsed));
  const data = parsed.rows[0].data as Record<string, unknown>;
  assertEquals(data.extra, undefined);
  assertEquals(data.query, undefined);
  assertEquals((data.answer as string).length, 4000);
  assertEquals(data.retrievedTitles, ["Black hole"]);
  assertEquals(data.modelResidency, null);
  assertEquals(data.configLabel, "Qwen2.5-1.5B-Instruct (Q4_K_M)");
});

Deno.test("public labels only take letters, digits and a few separators", () => {
  const run = (deviceModel: string, configLabel: string) =>
    parsePayload(
      JSON.stringify({
        run: { runId: "r", evalSetVersion: "1", appVersion: "1.0.0", platform: "android", deviceBrand: "POCO", deviceModel, soc: "SM8250" },
        rows: [{ queryId: "q", configId: "m", outcome: "success", configLabel }],
      }),
      "android",
    );
  const ok = run("M2012K11AG", "Roteamento adaptativo (predefinição: equilibrado)");
  assert(!("error" in ok));
  assertEquals(ok.run.device_model, "M2012K11AG");
  assertEquals((ok.rows[0].data as Record<string, unknown>).configLabel, "Roteamento adaptativo (predefinição: equilibrado)");
  const bad = run("<img src=x onerror=alert(1)>", "Qwen‮gnp.exe");
  assert(!("error" in bad));
  assertEquals(bad.run.device_model, null);
  assertEquals((bad.rows[0].data as Record<string, unknown>).configLabel, null);
});

Deno.test("a run holds at most 204 rows", () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ queryId: `q${i}`, configId: "m", outcome: "success" }));
  const body = (n: number) => JSON.stringify({ run: { runId: "r", evalSetVersion: "1", appVersion: "1", platform: "android" }, rows: rows.slice(0, n) });
  assertEquals(parsePayload(body(205), "android"), { error: "rows must hold 1 to 204 items" });
  assert(!("error" in parsePayload(body(204), "android")));
});
