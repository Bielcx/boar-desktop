// Receives one evaluation run from the app and stores it, only from a real phone running BOAR.
//
// POST /functions/v1/submit-results, header `apikey: <publishable key>`, JSON body:
//
// 1. { "step": "challenge" } -> 200 { challenge }: a one-time nonce, valid for 5 minutes.
// 2. { "step": "submit", challenge, payload, signature, device } -> 201 { id, rows, hidden, scores }
//    - payload: a JSON string { run: {...}, rows: [<eval JSONL row>, ...] } (see payload.ts).
//    - signature: over the UTF-8 of `${challenge}.${payload}` with the phone's hardware key.
//      Android: DER ECDSA from the Keystore key. iOS: an App Attest assertion.
//    - device: { platform: "android", attestation: [cert, ...] } or
//      { platform: "ios", keyId, attestation: [attestationObject] } the first time (the key's
//      attestation must carry this same challenge); afterwards { platform, id }.
//      An Android phone whose secure hardware can't attest sends { platform: "android",
//      attestation: [], publicKey, attestationError? }: its runs are stored for review, hidden.
//
// Once the key is checked, every answer also carries `device`, the id the app sends from then on.
// Errors: 400 bad request · 401 bad key, signature or challenge · 403 banned · 409 already
// shared · 412 unknown device (make a new key) · 429 { error, retryAt? }: rate_limited or cooldown
// (this device), network_limited (this network) · 503 busy or review_queue_full.
// A 201 carries pendingReview: true for an unattested phone. The limits and the storing happen in
// submit_eval_run() in one transaction; see
// supabase/migrations/20260929200000_secure_sharing.sql.
//
// The publishable key is public (it ships in the APK), so it only keeps out random callers; the
// hardware key is what makes curl useless. verify_jwt is off (supabase/config.toml) because the
// new API keys aren't JWTs.
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AttestError,
  b64decode,
  b64encode,
  deviceIdFromSpki,
  verifyAndroid,
  verifyAndroidSignature,
  verifyIos,
  verifyIosAssertion,
} from "./attest.ts";
import { parsePayload } from "./payload.ts";

// The largest run payload.ts accepts (204 rows) is about 1 MB once signed and escaped.
const MAX_BODY_BYTES = 1.5 * 1024 * 1024;
const PACKAGE_NAME = "team.sopa.aoair";
/** SHA-256 of BOAR's release signing certificate. Debug builds share Expo's public debug key, so
 * they can't share runs. More (comma-separated) in ANDROID_CERT_DIGESTS, e.g. after a key change. */
const RELEASE_CERT = "7cf514f9ab8253cbd78eb7d112d66fd05c2ad27e6fc987bf8f3276a7eedf1f01";
/** "<Team ID>.team.sopa.aoair"; iOS sharing is refused until it is set. */
const APPLE_APP_ID = Deno.env.get("APPLE_APP_ID") ?? "";
const MAX_CHALLENGES_PER_10_MIN = 3000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function keys(name: string): string[] {
  try {
    return Object.values(JSON.parse(Deno.env.get(name) ?? "{}")) as string[];
  } catch {
    return [];
  }
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256hex = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const b64url = (b: Uint8Array) => b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const secret = keys("SUPABASE_SECRET_KEYS")[0] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, secret, { auth: { persistSession: false } });
const certDigests = [
  RELEASE_CERT,
  ...(Deno.env.get("ANDROID_CERT_DIGESTS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
];

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (!keys("SUPABASE_PUBLISHABLE_KEYS").includes(req.headers.get("apikey") ?? "")) {
    return json(401, { error: "invalid apikey" });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "body too large" });
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  // Supabase's gateway replaces x-forwarded-for with the caller's address: checked on 2026-09-30
  // by sending forged values (one address, a list, two headers), which all hashed the same as none.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ipHash = ip ? await sha256hex(`${secret}:${ip}`) : null;

  if (body?.step === "challenge") {
    const { count, error: countError } = await db
      .from("eval_challenges")
      .select("challenge", { count: "exact", head: true })
      .gte("created_at", new Date(Date.now() - 600_000).toISOString());
    if (countError) return json(500, { error: "could not issue a challenge" });
    if ((count ?? 0) >= MAX_CHALLENGES_PER_10_MIN) return json(503, { error: "busy" });
    const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const { data: issued, error } = await db.rpc("new_eval_challenge", { p_challenge: challenge, p_ip_hash: ipHash });
    if (error) return json(500, { error: "could not issue a challenge" });
    if (!issued) return json(429, { error: "network_limited" });
    return json(200, { challenge });
  }
  if (body?.step !== "submit") return json(400, { error: "step must be challenge or submit" });

  const { challenge, payload, signature, device } = body;
  if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return json(400, { error: "bad challenge" });
  if (typeof payload !== "string" || typeof signature !== "string" || signature.length > 8192) {
    return json(400, { error: "payload and signature are required" });
  }
  const platform = device?.platform;
  if (platform !== "android" && platform !== "ios") return json(400, { error: "device.platform must be android or ios" });
  if (platform === "ios" && !APPLE_APP_ID) return json(403, { error: "sharing from iOS isn't open yet" });

  const parsed = parsePayload(payload, platform);
  if ("error" in parsed) return json(400, { error: parsed.error });

  // Used up now, whatever happens next: a request can't be replayed.
  const { data: fresh, error: challengeError } = await db.rpc("take_eval_challenge", { p_challenge: challenge });
  if (challengeError) return json(500, { error: "could not check the challenge" });
  if (!fresh) return json(401, { error: "challenge expired or already used" });

  const message = `${challenge}.${payload}`;
  let deviceId: string;
  let spki: Uint8Array;
  let signCount = 0;
  try {
    if (Array.isArray(device.attestation) && device.attestation.length === 0) {
      // No attestation (some genuine phones can't): register the bare key, runs wait for review.
      if (platform !== "android" || typeof device.publicKey !== "string" || device.publicKey.length > 400) {
        return json(400, { error: "an unattested key needs platform android and its publicKey" });
      }
      const bare = b64decode(device.publicKey);
      try {
        await crypto.subtle.importKey("spki", bare as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      } catch {
        return json(400, { error: "publicKey must be a P-256 SubjectPublicKeyInfo" });
      }
      deviceId = await deviceIdFromSpki(bare);
      const reason = typeof device.attestationError === "string" ? device.attestationError.slice(0, 200) : null;
      const { error } = await db.from("eval_devices").upsert(
        { id: deviceId, platform, public_key: b64encode(bare), attested: false, attestation: { attested: false, reason } },
        { onConflict: "id", ignoreDuplicates: true },
      );
      if (error) return json(500, { error: "could not save the device" });
    } else if (Array.isArray(device.attestation)) {
      // First share from this key: check what the hardware says about it, then remember it.
      const attested = platform === "android"
        ? await verifyAndroid(device.attestation, challenge, { packageName: PACKAGE_NAME, certDigests })
        : await verifyIos(String(device.attestation[0] ?? ""), String(device.keyId ?? ""), challenge, APPLE_APP_ID);
      deviceId = "id" in attested ? String(attested.id) : await deviceIdFromSpki(attested.spki);
      const { error } = await db.from("eval_devices").upsert(
        { id: deviceId, platform, public_key: b64encode(attested.spki), attestation: attested.info },
        { onConflict: "id", ignoreDuplicates: true },
      );
      if (error) return json(500, { error: "could not save the device" });
    } else {
      deviceId = String(device.id ?? "");
      if (!/^[0-9a-f]{64}$/.test(deviceId)) return json(400, { error: "device.id or device.attestation is required" });
    }
  } catch (e) {
    if (e instanceof AttestError) return json(401, { error: `attestation refused: ${e.message}` });
    console.error("attestation check failed", e);
    return json(503, { error: "could not check the attestation" });
  }

  const { data: known, error: deviceError } = await db.from("eval_devices")
    .select("platform, public_key, sign_count, banned").eq("id", deviceId).maybeSingle();
  if (deviceError) return json(500, { error: "could not read the device" });
  if (!known || known.platform !== platform) return json(412, { error: "unknown device" });
  if (known.banned) return json(403, { error: "banned" });
  spki = b64decode(known.public_key);
  signCount = Number(known.sign_count);

  if (platform === "android") {
    if (!(await verifyAndroidSignature(spki, signature, message))) return json(401, { error: "bad signature" });
  } else {
    const counter = await verifyIosAssertion(spki, signature, message, APPLE_APP_ID, signCount);
    if (counter === null) return json(401, { error: "bad signature" });
    const { data: bumped, error } = await db.from("eval_devices").update({ sign_count: counter })
      .eq("id", deviceId).lt("sign_count", counter).select("id");
    if (error) return json(500, { error: "could not save the device" });
    if (!bumped?.length) return json(401, { error: "bad signature" }); // a parallel request used this counter
  }

  // From here the request is proven to come from this device: tell the app its id.
  const reply = (status: number, body: Record<string, unknown>) => json(status, { ...body, device: deviceId });
  const { data: result, error: submitError } = await db.rpc("submit_eval_run", {
    p_device: deviceId,
    p_ip_hash: ipHash,
    p_run: parsed.run,
    p_rows: parsed.rows,
  });
  if (submitError || !result) {
    console.error("submit_eval_run failed", submitError);
    return reply(500, { error: "could not save the run" });
  }
  switch (result.error) {
    case undefined:
      return reply(201, {
        id: result.id,
        rows: parsed.rows.length,
        hidden: result.hidden,
        pendingReview: result.pending_review === true,
        scores: result.scores,
      });
    case "rate_limited":
    case "cooldown":
      return reply(429, { error: result.error, retryAt: result.retry_at ?? null });
    case "network_limited":
      return reply(429, { error: result.error });
    case "duplicate":
      return reply(409, { error: "run already submitted" });
    case "unknown_device":
      return reply(412, { error: "unknown device" });
    case "banned":
      return reply(403, { error: "banned" });
    case "busy":
    case "review_queue_full":
      return reply(503, { error: result.error });
    default:
      return reply(400, { error: result.error });
  }
});
