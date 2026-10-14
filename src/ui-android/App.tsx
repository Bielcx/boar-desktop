import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { StyleSheet, ActivityIndicator, View, Platform } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import "../i18n";
import { LanguageProvider } from "../i18n/LanguageContext";
import { ChatScreen } from "./ChatScreen";
import { ModelSetupScreen } from "./ModelSetupScreen";
import { ModelManager } from "../models/ModelManager";
import { ThemeProvider, useTheme } from "./theme";
import { initHaptics } from "../services/haptics";
import { FONT_FILES } from "./theme/fontFiles";
import { DesktopColumn } from "./desktopLayout";
import { applyWebCopy } from "./webCopy";
import { startFolderWatch } from "../services/folderWatch";
import { lockIfSet, lockNow } from "../services/pinLock";
import { startApiServer } from "../services/apiServer";
import { PinLockScreen } from "./PinLockScreen";

// The desktop app (react-native-web): "this computer" instead of "this phone", see webCopy.ts.
if (Platform.OS === "web") applyWebCopy();

const modelManager = new ModelManager();

// ponytail: one fixed delay; a setting if people ask for a different one.
const AUTO_LOCK_MS = 5 * 60_000;

type Screen = "checking" | "required-setup" | "chat";

function AppContent() {
  const [screen, setScreen] = useState<Screen>("checking");
  // With a PIN (desktop): locked at start until it's entered, and again after AUTO_LOCK_MS with the window out of focus.
  const [locked, setLocked] = useState<boolean | null>(null);
  const [unlockedOnce, setUnlockedOnce] = useState(false);
  const { colors } = useTheme();
  // Bundled files, so this is quick; on an error the text falls back to the system font.
  const [fontsLoaded, fontError] = useFonts(FONT_FILES);
  const fontsReady = fontsLoaded || fontError !== null;

  useEffect(() => {
    initHaptics();
  }, []);

  // Desktop watched folders (Settings): batches are imported once the chat, and so the embedding model, is up.
  useEffect(() => (screen === "chat" ? startFolderWatch() : undefined), [screen]);
  // Desktop local API (Settings): requests are answered once the chat, and so the models, are up.
  useEffect(() => (screen === "chat" ? startApiServer() : undefined), [screen]);

  useEffect(() => {
    lockIfSet().then(setLocked, () => setLocked(false));
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const away = () => {
      timer = setTimeout(async () => {
        if (await lockIfSet()) {
          lockNow();
          setLocked(true);
        }
      }, AUTO_LOCK_MS);
    };
    const back = () => clearTimeout(timer);
    window.addEventListener("blur", away);
    window.addEventListener("focus", back);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", away);
      window.removeEventListener("focus", back);
    };
  }, []);

  useEffect(() => {
    (async () => {
      const ready = await modelManager.requiredModelsPresent();
      setScreen(ready ? "chat" : "required-setup");
    })();
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg.terminal }]} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      {(screen === "checking" || !fontsReady || locked === null) && (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.emerald[400]} size="large" />
        </View>
      )}
      {fontsReady && screen === "required-setup" && (
        <DesktopColumn>
          <ModelSetupScreen mode="required" onReady={() => setScreen("chat")} />
        </DesktopColumn>
      )}
      {/* The chat mounts once unlocked (it reads the chats); a later lock hides it, keeping its state. */}
      {fontsReady && screen === "chat" && (locked === false || unlockedOnce) && (
        <View style={[styles.container, locked && styles.hidden]}>
          <ChatScreen onRelaunchWizard={() => setScreen("required-setup")} />
        </View>
      )}
      {fontsReady && screen !== "checking" && locked === true && (
        <View style={StyleSheet.absoluteFill}>
          <PinLockScreen
            onUnlocked={() => {
              setUnlockedOnce(true);
              setLocked(false);
            }}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <LanguageProvider>
        <ThemeProvider>
          <AppContent />
        </ThemeProvider>
      </LanguageProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Covered by the lock screen, and out of the accessibility tree and tab order.
  hidden: { display: "none" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
