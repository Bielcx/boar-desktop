import React, { useEffect, useState } from "react";
import { View, StyleSheet, Switch, Pressable, Alert } from "react-native";
import { colors } from "./theme/colors";
import { Text } from "./components/AppText";
import { useTranslation } from "react-i18next";
import { getMemorySettings, setMemorySettings, MemorySettings as MemorySettingsType } from "../models/settings";
import { clearAllHistory } from "../services/chatHistory";

const TURN_OPTIONS = [4, 6, 8, 10] as const;
const SESSION_OPTIONS = [
  { value: 10, label: "10" },
  { value: 25, label: "25" },
  { value: 50, label: "50" },
  { value: 0, label: null },
] as const;

export function MemorySettings({ onCleared }: { onCleared?: () => void }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<MemorySettingsType | null>(null);

  useEffect(() => {
    getMemorySettings().then(setSettings);
  }, []);

  const update = async (patch: Partial<MemorySettingsType>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    await setMemorySettings(patch);
  };

  const confirmClearAll = () => {
    Alert.alert(
      t("memorySettings.clearAllConfirmTitle"),
      t("memorySettings.clearAllConfirmMessage"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("memorySettings.clearAllButton"),
          style: "destructive",
          onPress: async () => {
            await clearAllHistory();
            onCleared?.();
          },
        },
      ]
    );
  };

  if (!settings) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("memorySettings.title")}</Text>

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>{t("memorySettings.autoSummarizeLabel")}</Text>
          <Text style={styles.rowValue}>{t("memorySettings.autoSummarizeValue")}</Text>
        </View>
        <Switch
          value={settings.autoSummarize}
          onValueChange={(v) => update({ autoSummarize: v })}
          trackColor={{ false: colors.border.default, true: colors.emerald[500] }}
        />
      </View>

      <Text style={styles.subheading}>{t("memorySettings.turnsBeforeSummarizing")}</Text>
      <View style={styles.pillRow}>
        {TURN_OPTIONS.map((n) => (
          <Pressable
            key={n}
            style={[styles.pill, settings.historyTurnThreshold === n && styles.pillSelected]}
            onPress={() => update({ historyTurnThreshold: n })}
          >
            <Text style={[styles.pillText, settings.historyTurnThreshold === n && styles.pillTextSelected]}>
              {n}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.subheading}>{t("memorySettings.maxSavedSessions")}</Text>
      <View style={styles.pillRow}>
        {SESSION_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            style={[styles.pill, settings.maxSavedSessions === opt.value && styles.pillSelected]}
            onPress={() => update({ maxSavedSessions: opt.value })}
          >
            <Text
              style={[styles.pillText, settings.maxSavedSessions === opt.value && styles.pillTextSelected]}
            >
              {opt.label ?? t("memorySettings.unlimited")}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>{t("memorySettings.autoTitlesLabel")}</Text>
          <Text style={styles.rowValue}>{t("memorySettings.autoTitlesValue")}</Text>
        </View>
        <Switch
          value={settings.autoGenerateTitles}
          onValueChange={(v) => update({ autoGenerateTitles: v })}
          trackColor={{ false: colors.border.default, true: colors.emerald[500] }}
        />
      </View>

      <Pressable style={styles.clearBtn} onPress={confirmClearAll}>
        <Text style={styles.clearBtnText}>{t("memorySettings.clearAllChatHistory")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg.card, borderRadius: 10, padding: 14, margin: 12, gap: 12 },
  title: { color: colors.text.heading, fontSize: 14, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowLabel: { color: colors.text.primary, fontSize: 13, fontWeight: "600" },
  rowValue: { color: colors.text.muted, fontSize: 11, marginTop: 2 },
  subheading: { color: colors.text.secondary, fontSize: 12, fontWeight: "600" },
  pillRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  pill: { backgroundColor: colors.bg.cardHover, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  pillSelected: { backgroundColor: colors.emerald[600] },
  pillText: { color: colors.text.muted, fontSize: 12 },
  pillTextSelected: { color: colors.text.heading, fontWeight: "600" },
  clearBtn: {
    backgroundColor: colors.crimson.bgSubtle,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.crimson.border,
  },
  clearBtnText: { color: colors.crimson[400], fontSize: 13, fontWeight: "700" },
});
