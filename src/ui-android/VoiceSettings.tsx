import React, { useEffect, useState } from "react";
import { View, StyleSheet, Switch } from "react-native";
import { colors } from "./theme/colors";
import { Text } from "./components/AppText";
import { useTranslation } from "react-i18next";
import { isVoiceInputAvailable } from "../voice/VoiceInput";
import { getSpeakAnswers, getVoiceInputEnabled, setSpeakAnswers, setVoiceInputEnabled } from "../models/settings";
import { speechAvailable, stopSpeaking } from "../voice/speech";

// Haptic feedback is an app-wide setting (src/services/haptics.ts), not
// voice-specific — its toggle lives in the Display & Theme section now
// (ModelSetupScreen.tsx), alongside the rest of the interface/feedback
// preferences, not here.
export function VoiceSettings() {
  const { t } = useTranslation();
  const [voiceAvailable, setVoiceAvailable] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [speakAnswers, setSpeakAnswersState] = useState(false);

  useEffect(() => {
    isVoiceInputAvailable().then(setVoiceAvailable).catch(() => setVoiceAvailable(false));
    getVoiceInputEnabled().then(setEnabled);
    getSpeakAnswers().then(setSpeakAnswersState);
  }, []);

  const toggleSpeak = async (value: boolean) => {
    setSpeakAnswersState(value);
    if (!value) stopSpeaking();
    await setSpeakAnswers(value);
  };

  const toggle = async (value: boolean) => {
    setEnabled(value);
    await setVoiceInputEnabled(value);
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("voiceSettings.title")}</Text>

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>{t("voiceSettings.enabledLabel")}</Text>
          <Text style={styles.rowValue}>{t("voiceSettings.enabledValue")}</Text>
        </View>
        <Switch value={enabled} onValueChange={toggle} trackColor={{ false: colors.border.default, true: colors.emerald[500] }} />
      </View>

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>{t("voiceSettings.speechEngineLabel")}</Text>
          <Text style={styles.rowValue}>
            {voiceAvailable == null
              ? t("voiceSettings.checking")
              : voiceAvailable
                ? t("voiceSettings.available")
                : t("voiceSettings.unavailable")}
          </Text>
        </View>
      </View>
      {speechAvailable() && (
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>{t("voiceSettings.speakLabel")}</Text>
            <Text style={styles.rowValue}>{t("voiceSettings.speakValue")}</Text>
          </View>
          <Switch value={speakAnswers} onValueChange={toggleSpeak} trackColor={{ false: colors.border.default, true: colors.emerald[500] }} />
        </View>
      )}

      {voiceAvailable === false && (
        <Text style={styles.note}>{t("voiceSettings.unavailableNote")}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg.card, borderRadius: 10, padding: 14, margin: 12, gap: 12 },
  title: { color: colors.text.heading, fontSize: 14, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowLabel: { color: colors.text.primary, fontSize: 13, fontWeight: "600" },
  rowValue: { color: colors.text.muted, fontSize: 12, marginTop: 2 },
  note: { color: colors.text.dim, fontSize: 11, lineHeight: 16 },
});
