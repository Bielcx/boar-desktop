import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Static audit backing the offline build: every place in the app's own code
 * that can open a network connection must be listed here AND check
 * networkAllowed() (src/config/variant.ts). A new call site fails this test
 * until someone decides how it behaves in the offline variant.
 */
const ROOT = join(__dirname, "..", "..");
const NETWORK_CALL = /\b(fetch\(|new XMLHttpRequest|new WebSocket|createDownloadResumable\(|downloadAsync\(|uploadAsync\(|EventSource\()/;

const ALLOWED: Record<string, string> = {
  "src/models/ModelManager.ts": "downloadCatalogModel checks networkAllowed() first",
  "src/services/modelBrowser.ts": "assertNetwork() before each fetch",
  "src/eval/shareResults.ts": "networkAllowed() first; only after the user confirms the share preview",
};

// Client libraries that would add network paths (or cloud services) of their own.
const FORBIDDEN_DEPENDENCIES = [
  "expo-updates",
  "expo-notifications",
  "@react-native-firebase/app",
  "firebase",
  "@sentry/react-native",
  "axios",
  // expo-network is allowed: it only reads the phone's own state (Android ConnectivityManager, iOS
  // NWPathMonitor) for the header's ONLINE/OFFLINE pill, and opens no connection of its own
  // (checked in its Kotlin and Swift sources, 57.0.x). netinfo stays out: its reachability check
  // requests a URL.
  "@react-native-community/netinfo",
  // Location through Google Play Services (FusedLocationProviderClient): breaks
  // on GrapheneOS. Use modules/offline-location (plain LocationManager) instead.
  "expo-location",
  "react-native-geolocation-service",
  "@react-native-community/geolocation",
];

// Google Play Services / Firebase in a native Android dependency's Gradle file.
const GMS_GRADLE = /play-services|com\.google\.android\.gms|com\.google\.firebase/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("network call sites", () => {
  const files = [...sourceFiles(join(ROOT, "src")), join(ROOT, "App.tsx")];

  it("only appear in the allow-listed files", () => {
    const offenders = files
      .map((f) => relative(ROOT, f))
      .filter((f) => NETWORK_CALL.test(readFileSync(join(ROOT, f), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "")));
    expect(offenders.sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it("are all guarded by networkAllowed()", () => {
    for (const f of Object.keys(ALLOWED)) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/networkAllowed\(\)/);
    }
  });
});

describe("dependencies", () => {
  it("pull in no Google Play Services or Firebase on Android (local modules and direct deps)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const gradleFiles = Object.keys(pkg.dependencies ?? {})
      .map((d) => join(ROOT, "node_modules", d, "android", "build.gradle"))
      .filter((f) => {
        try {
          return statSync(f).isFile();
        } catch {
          return false;
        }
      });
    expect(gradleFiles.length).toBeGreaterThan(3);
    const offenders = gradleFiles.filter((f) => GMS_GRADLE.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("include no network/cloud client libraries", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.filter((d) => FORBIDDEN_DEPENDENCIES.includes(d))).toEqual([]);
  });
});
