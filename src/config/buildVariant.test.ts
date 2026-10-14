import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { parseVariant as parseJsVariant } from "./variant";

const require = createRequire(import.meta.url);
const plugin = require("../../plugins/withBuildVariant.js");
const appJson = require("../../app.json");

const INTERNET = "android.permission.INTERNET";

function build(env: Record<string, string>) {
  // Only the synchronous part (mods run at prebuild) matters here.
  return plugin.applyBuildVariant(structuredClone(appJson.expo), env);
}

describe("offline build variant", () => {
  it("blocks every network permission and the microphone", () => {
    const cfg = build({ EXPO_PUBLIC_BOAR_VARIANT: "offline" });
    for (const p of plugin.NETWORK_PERMISSIONS) expect(cfg.android.blockedPermissions).toContain(p);
    expect(cfg.android.blockedPermissions).toContain("android.permission.RECORD_AUDIO");
    expect(cfg.android.permissions ?? []).not.toContain(INTERNET);
  });

  it("keeps the microphone only when built with voice", () => {
    const cfg = build({ EXPO_PUBLIC_BOAR_VARIANT: "offline", EXPO_PUBLIC_BOAR_VOICE: "1" });
    expect(cfg.android.blockedPermissions).toContain(INTERNET);
    expect(cfg.android.blockedPermissions).not.toContain("android.permission.RECORD_AUDIO");
  });

  it("installs next to the downloader build and says what it is", () => {
    const cfg = build({ EXPO_PUBLIC_BOAR_VARIANT: "offline" });
    expect(cfg.android.package).toBe(`${appJson.expo.android.package}.offline`);
    expect(cfg.name).toMatch(/Offline$/);
    expect(cfg.extra.boarVariant).toBe("offline");
  });
});

describe("downloader build variant (default)", () => {
  it("keeps INTERNET but still drops SYSTEM_ALERT_WINDOW and storage permissions", () => {
    const cfg = build({});
    expect(cfg.android.blockedPermissions).not.toContain(INTERNET);
    expect(cfg.android.blockedPermissions).toContain("android.permission.SYSTEM_ALERT_WINDOW");
    expect(cfg.android.blockedPermissions).toContain("android.permission.WRITE_EXTERNAL_STORAGE");
    expect(cfg.android.package).toBe(appJson.expo.android.package);
    expect(cfg.extra.boarVariant).toBe("downloader");
  });

  it("disables backup in both variants", () => {
    expect(build({}).android.allowBackup).toBe(false);
    expect(build({ EXPO_PUBLIC_BOAR_VARIANT: "offline" }).android.allowBackup).toBe(false);
  });
});

describe("native and JS agree on the variant", () => {
  it("parses the same env value the same way", () => {
    for (const raw of ["offline", "OFFLINE ", "downloader", "", undefined, "x"]) {
      expect(plugin.parseVariant(raw)).toBe(parseJsVariant(raw));
    }
  });
});

describe("location", () => {
  it("is declared (foreground only) in both variants, and background location is blocked", () => {
    for (const env of [{}, { EXPO_PUBLIC_BOAR_VARIANT: "offline" }] as Record<string, string>[]) {
      const cfg = build(env);
      for (const p of plugin.LOCATION_PERMISSIONS) {
        expect(cfg.android.permissions).toContain(p);
        expect(cfg.android.blockedPermissions).not.toContain(p);
      }
      expect(cfg.android.blockedPermissions).toContain("android.permission.ACCESS_BACKGROUND_LOCATION");
    }
  });

  it("does not bring back any network permission in the offline variant", () => {
    const cfg = build({ EXPO_PUBLIC_BOAR_VARIANT: "offline" });
    for (const p of plugin.NETWORK_PERMISSIONS) expect(cfg.android.permissions).not.toContain(p);
  });
});

describe("activity configChanges", () => {
  const EXPO_DEFAULT = "keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize|assetsPaths";

  it("adds density, locale and layoutDirection to Expo's defaults (display size change must not restart setup)", () => {
    const flags = plugin.mergeConfigChanges(EXPO_DEFAULT).split("|");
    for (const f of ["density", "uiMode", "locale", "layoutDirection", "orientation", "screenSize"]) {
      expect(flags).toContain(f);
    }
    expect(flags).toContain("assetsPaths"); // keeps what was there
    expect(new Set(flags).size).toBe(flags.length);
  });

  it("leaves fontScale out, and removes it from an existing manifest, so a font size change recreates the activity (Prism FS-1)", () => {
    expect(plugin.REQUIRED_CONFIG_CHANGES).not.toContain("fontScale");
    const flags = plugin.mergeConfigChanges(`${EXPO_DEFAULT}|fontScale|density`).split("|");
    expect(flags).not.toContain("fontScale");
    expect(flags).toContain("density");
  });

  it("works from an empty attribute and is idempotent", () => {
    const once = plugin.mergeConfigChanges(undefined);
    expect(once.split("|")).toEqual(plugin.REQUIRED_CONFIG_CHANGES);
    expect(plugin.mergeConfigChanges(once)).toBe(once);
  });

  it("is applied to the main activity by the variant plugin (mod registered)", () => {
    const cfg = build({});
    expect(cfg.mods?.android?.manifest).toBeTypeOf("function");
  });
});

describe("backup and device transfer", () => {
  it("excludes every storage domain from cloud backup and from device transfer", () => {
    const xml: string = plugin.dataExtractionRulesXml();
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = xml.split(`<${section}>`)[1].split(`</${section}>`)[0];
      for (const d of plugin.BACKUP_DOMAINS) expect(body).toContain(`<exclude domain="${d}" path="." />`);
      expect(body).not.toContain("<include");
    }
  });
});
