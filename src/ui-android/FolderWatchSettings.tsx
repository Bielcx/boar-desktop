import React, { useEffect, useState } from "react";
import { View, StyleSheet, Switch, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { colors } from "./theme/colors";
import { Text } from "./components/AppText";
import { folderWatch, type FolderWatchState } from "../services/folderWatch";

/** Settings › Watched folders (desktop only; ModelSetupScreen hides the section when folderWatchAvailable() is false). */
export function FolderWatchSettings() {
  const { t } = useTranslation();
  const [state, setState] = useState<FolderWatchState | null>(null);

  useEffect(() => {
    folderWatch?.get().then(setState);
  }, []);

  if (!folderWatch || !state) return null;
  const fw = folderWatch;
  const switchColors = { false: colors.border.default, true: colors.emerald[500] };

  return (
    <View style={styles.card}>
      <Text style={styles.note}>{t("folderWatch.hint")}</Text>

      {state.folders.length === 0 && <Text style={styles.rowValue}>{t("folderWatch.empty")}</Text>}
      {state.folders.map((f) => (
        <View key={f.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>📁 {f.name}</Text>
            <Text style={styles.rowValue} numberOfLines={1}>{f.path}</Text>
          </View>
          <Pressable onPress={() => fw.removeFolder(f.id).then(setState)} hitSlop={8} accessibilityLabel={t("folderWatch.stop")}>
            <Text style={styles.link}>{t("folderWatch.stop")}</Text>
          </Pressable>
        </View>
      ))}

      <Pressable style={styles.addBtn} onPress={() => fw.addFolder().then(setState)}>
        <Text style={styles.addBtnText}>＋ {t("folderWatch.add")}</Text>
      </Pressable>

      {state.folders.length > 0 && (
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>{t("folderWatch.activeLabel")}</Text>
            <Text style={styles.rowValue}>{t("folderWatch.activeValue")}</Text>
          </View>
          <Switch value={!state.paused} onValueChange={(v) => fw.setPaused(!v).then(setState)} trackColor={switchColors} />
        </View>
      )}

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>{t("folderWatch.trayLabel")}</Text>
          <Text style={styles.rowValue}>{t("folderWatch.trayValue")}</Text>
        </View>
        <Switch value={state.trayOnClose} onValueChange={(v) => fw.setTrayOnClose(v).then(setState)} trackColor={switchColors} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg.card, borderRadius: 10, padding: 14, margin: 12, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowLabel: { color: colors.text.primary, fontSize: 13, fontWeight: "600" },
  rowValue: { color: colors.text.muted, fontSize: 12, marginTop: 2 },
  note: { color: colors.text.dim, fontSize: 11, lineHeight: 16 },
  link: { color: colors.emerald[400], fontSize: 12, fontWeight: "600" },
  addBtn: { backgroundColor: colors.emerald[600], borderRadius: 6, paddingVertical: 10, alignItems: "center" },
  addBtnText: { color: colors.text.heading, fontSize: 13, fontWeight: "600" },
});
