// Proof that a shared run comes from a real phone running BOAR, and signature checks.
//
// Android: a Keystore key's attestation chain must end at one of Google's attestation roots and
// be unrevoked; the leaf's key description must say the key lives in secure hardware (TEE or
// StrongBox, not software), carry our one-time challenge, and name this app signed with BOAR's
// release key. Rooted or unlocked phones pass (the boot state is recorded, not required).
// https://developer.android.com/privacy-and-security/security-key-attestation
//
// iOS: an App Attest attestation must chain to Apple's App Attestation root and bind the key to
// our challenge and App ID; later requests carry assertions with a rising counter.
// https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
import "npm:reflect-metadata@0.2.2"; // @peculiar/x509 needs it before it loads
import { X509Certificate } from "npm:@peculiar/x509@2.1.0";
import { AsnParser } from "npm:@peculiar/asn1-schema@2.10.0";
import {
  AttestationApplicationId,
  id_ce_keyDescription,
  NonStandardKeyDescription,
  SecurityLevel,
} from "npm:@peculiar/asn1-android@2.10.0";
import { decode as cborDecode } from "npm:cbor-x@1.6.6";
import { APPLE_APP_ATTEST_ROOT, GOOGLE_ROOTS } from "./roots.ts";

export class AttestError extends Error {}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (b: Uint8Array | ArrayBuffer) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
export const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64encode = (b: Uint8Array | ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const cert = (b: string | Uint8Array) => {
  try {
    return new X509Certificate(typeof b === "string" ? b : (b as BufferSource));
  } catch {
    throw new AttestError("unreadable certificate");
  }
};

/** The serials Google has revoked (leaked or broken keys), refreshed at most hourly. */
let revoked: { at: number; serials: Set<string> } | null = null;
async function revokedSerials(): Promise<Set<string>> {
  if (revoked && Date.now() - revoked.at < 3600_000) return revoked.serials;
  const res = await fetch("https://android.googleapis.com/attestation/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`attestation status list: HTTP ${res.status}`);
  const body = await res.json();
  revoked = { at: Date.now(), serials: new Set(Object.keys(body.entries ?? {}).map((s) => s.toLowerCase())) };
  return revoked.serials;
}
const serial = (c: X509Certificate) => c.serialNumber.toLowerCase().replace(/^0+(?=.)/, "");

async function verifyChain(chain: X509Certificate[], roots: X509Certificate[]) {
  for (let i = 0; i < chain.length - 1; i++) {
    if (!(await chain[i].verify({ publicKey: chain[i + 1].publicKey, signatureOnly: true }))) {
      throw new AttestError("broken certificate chain");
    }
  }
  const top = chain[chain.length - 1];
  const topKey = new Uint8Array(top.publicKey.rawData);
  for (const root of roots) {
    if (equal(topKey, new Uint8Array(root.publicKey.rawData))) return; // the root itself
    if (await top.verify({ publicKey: root.publicKey, signatureOnly: true })) return; // signed by it
  }
  throw new AttestError("chain doesn't end at the attestation root");
}

export interface AndroidExpect {
  packageName: string;
  /** SHA-256 of the app's signing certificates, lowercase hex. */
  certDigests: string[];
  /** Skipped only in tests with saved chains; always on in the function. */
  checkRevocation?: boolean;
}

export interface Attested {
  /** SubjectPublicKeyInfo DER of the attested key. */
  spki: Uint8Array;
  /** Stored in eval_devices.attestation. */
  info: Record<string, unknown>;
}

export async function verifyAndroid(chainB64: string[], challenge: string, expect: AndroidExpect): Promise<Attested> {
  if (!Array.isArray(chainB64) || chainB64.length < 2 || chainB64.length > 8) {
    throw new AttestError("attestation chain must hold 2 to 8 certificates");
  }
  const chain = chainB64.map((c) => cert(typeof c === "string" ? b64decode(c) : ""));
  await verifyChain(chain, GOOGLE_ROOTS.map((p) => cert(p)));
  if (expect.checkRevocation !== false) {
    const bad = await revokedSerials();
    if (chain.some((c) => bad.has(serial(c)))) throw new AttestError("revoked attestation key");
  }

  const ext = chain[0].getExtension(id_ce_keyDescription);
  if (!ext) throw new AttestError("no key description");
  let kd: NonStandardKeyDescription;
  try {
    kd = AsnParser.parse(ext.value, NonStandardKeyDescription);
  } catch {
    throw new AttestError("unreadable key description");
  }
  if (kd.attestationSecurityLevel === SecurityLevel.software || kd.keymasterSecurityLevel === SecurityLevel.software) {
    throw new AttestError("software-backed key");
  }
  if (!equal(new Uint8Array(kd.attestationChallenge.buffer), enc.encode(challenge))) {
    throw new AttestError("wrong challenge");
  }

  const appIdRaw = kd.softwareEnforced.findProperty("attestationApplicationId") ??
    kd.teeEnforced.findProperty("attestationApplicationId");
  if (!appIdRaw) throw new AttestError("no application id");
  let appId: AttestationApplicationId;
  try {
    appId = AsnParser.parse(appIdRaw.buffer, AttestationApplicationId);
  } catch {
    throw new AttestError("unreadable application id");
  }
  const dec = new TextDecoder();
  // The schema hands these over as bare ArrayBuffers (typed as OctetString).
  const bytes = (x: unknown) => new Uint8Array((x as { buffer?: ArrayBuffer }).buffer ?? (x as ArrayBuffer));
  const packages = (appId.packageInfos ?? []).map((p) => dec.decode(bytes(p.packageName)));
  const digests = (appId.signatureDigests ?? []).map((d) => hex(bytes(d)));
  if (!packages.includes(expect.packageName)) throw new AttestError("key made by another app");
  if (!digests.some((d) => expect.certDigests.includes(d))) throw new AttestError("app not signed with the release key");

  const rot = kd.teeEnforced.findProperty("rootOfTrust");
  const spki = new Uint8Array(chain[0].publicKey.rawData);
  return {
    spki,
    info: {
      securityLevel: kd.attestationSecurityLevel === SecurityLevel.strongBox ? "strongbox" : "tee",
      attestationVersion: kd.attestationVersion,
      deviceLocked: rot?.deviceLocked ?? null,
      verifiedBootState: rot ? ["verified", "self_signed", "unverified", "failed"][rot.verifiedBootState] ?? null : null,
      verifiedBootKey: rot ? hex(rot.verifiedBootKey.buffer) : null,
      osVersion: kd.teeEnforced.findProperty("osVersion") ?? null,
      osPatchLevel: kd.teeEnforced.findProperty("osPatchLevel") ?? null,
      appCert: digests[0],
    },
  };
}

/** ECDSA signatures arrive DER-encoded; WebCrypto wants r || s. */
function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) throw new AttestError("bad signature");
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part++) {
    if (i + 2 > der.length || der[i] !== 0x02) throw new AttestError("bad signature");
    let len = der[i + 1];
    let start = i + 2;
    if (len === 0 || start + len > der.length) throw new AttestError("bad signature");
    i = start + len;
    while (len > size && der[start] === 0) {
      start++;
      len--;
    }
    if (len > size) throw new AttestError("bad signature");
    out.set(der.subarray(start, start + len), part * size + (size - len));
  }
  return out;
}

async function ecdsaVerify(spki: Uint8Array, derSig: Uint8Array, message: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("spki", spki as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(derSig) as BufferSource, message as BufferSource);
}

/** Android: the Keystore key's DER signature over the UTF-8 message. */
export async function verifyAndroidSignature(spki: Uint8Array, signatureB64: string, message: string): Promise<boolean> {
  try {
    return await ecdsaVerify(spki, b64decode(signatureB64), enc.encode(message));
  } catch {
    return false;
  }
}

const APPATTEST_PROD = enc.encode("appattest\0\0\0\0\0\0\0");
const APPATTEST_DEV = enc.encode("appattestdevelop");

/** iOS: `appId` is "<Team ID>.<bundle id>". Returns the key and its id (hex). */
export async function verifyIos(
  attestationB64: string,
  keyIdB64: string,
  challenge: string,
  appId: string,
): Promise<Attested & { id: string }> {
  let att: { fmt?: string; attStmt?: { x5c?: Uint8Array[] }; authData?: Uint8Array };
  try {
    att = cborDecode(b64decode(attestationB64));
  } catch {
    throw new AttestError("unreadable attestation");
  }
  if (att?.fmt !== "apple-appattest" || !Array.isArray(att.attStmt?.x5c) || att.attStmt.x5c.length !== 2 || !att.authData) {
    throw new AttestError("not an App Attest attestation");
  }
  const chain = att.attStmt.x5c.map((c) => cert(new Uint8Array(c)));
  await verifyChain(chain, [cert(APPLE_APP_ATTEST_ROOT)]);

  const authData = new Uint8Array(att.authData);
  const clientDataHash = await sha256(enc.encode(challenge));
  const nonce = await sha256(new Uint8Array([...authData, ...clientDataHash]));
  const ext = chain[0].getExtension("1.2.840.113635.100.8.2");
  const ev = ext ? new Uint8Array(ext.value) : new Uint8Array();
  // SEQUENCE { [1] EXPLICIT OCTET STRING (32) nonce }
  const prefix = [0x30, 0x24, 0xa1, 0x22, 0x04, 0x20];
  if (ev.length !== 38 || !prefix.every((b, i) => ev[i] === b) || !equal(ev.subarray(6), nonce)) {
    throw new AttestError("wrong challenge");
  }

  const spki = new Uint8Array(chain[0].publicKey.rawData);
  const point = spki.subarray(spki.length - 65); // uncompressed P-256 point
  const keyId = b64decode(keyIdB64);
  if (!equal(await sha256(point), keyId)) throw new AttestError("key id doesn't match the key");
  if (authData.length < 55) throw new AttestError("short authenticator data");
  if (!equal(authData.subarray(0, 32), await sha256(enc.encode(appId)))) throw new AttestError("another app's key");
  const counter = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  if (counter !== 0) throw new AttestError("attestation counter must be 0");
  const aaguid = authData.subarray(37, 53);
  const production = equal(aaguid, APPATTEST_PROD);
  if (!production && !equal(aaguid, APPATTEST_DEV)) throw new AttestError("unknown App Attest environment");
  const credLen = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0);
  if (!equal(authData.subarray(55, 55 + credLen), keyId)) throw new AttestError("credential id doesn't match the key");

  return { spki, id: hex(keyId), info: { environment: production ? "production" : "development" } };
}

/** iOS: an assertion over SHA-256(message). Returns its counter, which must beat the stored one. */
export async function verifyIosAssertion(
  spki: Uint8Array,
  assertionB64: string,
  message: string,
  appId: string,
  lastCounter: number,
): Promise<number | null> {
  try {
    const a: { signature?: Uint8Array; authenticatorData?: Uint8Array } = cborDecode(b64decode(assertionB64));
    if (!a?.signature || !a.authenticatorData) return null;
    const authData = new Uint8Array(a.authenticatorData);
    if (authData.length < 37) return null;
    if (!equal(authData.subarray(0, 32), await sha256(enc.encode(appId)))) return null;
    const counter = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
    if (counter <= lastCounter) return null;
    const clientDataHash = await sha256(enc.encode(message));
    const nonce = await sha256(new Uint8Array([...authData, ...clientDataHash]));
    return (await ecdsaVerify(spki, new Uint8Array(a.signature), nonce)) ? counter : null;
  } catch {
    return null;
  }
}

export const deviceIdFromSpki = async (spki: Uint8Array) => hex(await sha256(spki));
