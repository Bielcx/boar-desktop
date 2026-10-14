import type { BundledFamily } from "./fonts";

/** Font files for useFonts (App.tsx). Bundled assets: loading never touches the network. */
export const FONT_FILES: Record<BundledFamily, number> = {
  Baloo2_700Bold: require("@expo-google-fonts/baloo-2/700Bold/Baloo2_700Bold.ttf"),
  Baloo2_800ExtraBold: require("@expo-google-fonts/baloo-2/800ExtraBold/Baloo2_800ExtraBold.ttf"),
  Lexend_400Regular: require("@expo-google-fonts/lexend/400Regular/Lexend_400Regular.ttf"),
  Lexend_500Medium: require("@expo-google-fonts/lexend/500Medium/Lexend_500Medium.ttf"),
  Lexend_600SemiBold: require("@expo-google-fonts/lexend/600SemiBold/Lexend_600SemiBold.ttf"),
  Lexend_700Bold: require("@expo-google-fonts/lexend/700Bold/Lexend_700Bold.ttf"),
};
