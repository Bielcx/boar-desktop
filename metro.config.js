// Desktop build (BOAR_TARGET=desktop, see desktop/README.md): native packages resolve to the
// desktop shims in desktop/src/shims, which reach Node through Electron IPC. Android/iOS untouched.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

if (process.env.BOAR_TARGET === "desktop") {
  const shims = path.join(__dirname, "desktop/src/shims");
  // Module name -> shim file name (also the handler and IPC channel prefix); preload and main read the same file.
  const shimFor = require("./desktop/src/shared/packages.json");
  // react-native-web's own Alert (a no-op) and Share (navigator.share, absent in Electron). Babel rewrites
  // `import { Alert } from "react-native"` to "react-native-web/dist/exports/Alert"; RNW's index requires
  // "./exports/Alert". Both resolve to these instead.
  const rnwExport = { Alert: "rn-alert.ts", Share: "rn-share.ts" };
  const rnwExportOf = (context, moduleName) => {
    const m = /^(react-native-web\/dist(?:\/cjs)?|\.)\/exports\/(Alert|Share)$/.exec(moduleName);
    if (!m) return undefined;
    return m[1] !== "." || /[\\/]react-native-web[\\/]dist[\\/]/.test(context.originModulePath) ? rnwExport[m[2]] : undefined;
  };
  // The app's own requireOptionalNativeModule("VoiceInput") (src/voice/VoiceInput.ts) finds the desktop module there.
  const appSrc = path.join(__dirname, "src") + path.sep;
  const expoCoreOf = (context, moduleName) =>
    moduleName === "expo-modules-core" && context.originModulePath.startsWith(appSrc) ? "expo-modules-core.ts" : undefined;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const file = Object.hasOwn(shimFor, moduleName)
      ? `${shimFor[moduleName]}.ts`
      : (rnwExportOf(context, moduleName) ?? expoCoreOf(context, moduleName));
    return file
      ? { type: "sourceFile", filePath: path.join(shims, file) }
      : context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;
