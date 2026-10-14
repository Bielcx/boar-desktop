import React, { useCallback, useEffect, useState } from "react";
import { View, StyleSheet, Switch, Pressable } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { colors } from "./theme/colors";
import { Text } from "./components/AppText";
import { listCustomCollections, type CustomCollection } from "../rag/db";

interface LibraryShareConfig {
  enabled: boolean;
  collections: string[];
  builtin: boolean;
}

/** Desktop only (desktop/src/shims/library-share.ts, desktop/docs/09-mcp.md); null on Android, where the section isn't shown. */
export const LibraryShare = requireOptionalNativeModule<{
  get(): Promise<LibraryShareConfig>;
  set(config: LibraryShareConfig): Promise<LibraryShareConfig>;
  clientConfig(): Promise<string>;
}>("LibraryShare");

/**
 * Settings > Share my library: lets other AI apps on this computer (Claude Desktop, Cursor...) search the library
 * through BOAR's MCP server, read-only. Off by default; only the collections ticked here are visible.
 */
export function LibraryShareSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<LibraryShareConfig | null>(null);
  const [collections, setCollections] = useState<CustomCollection[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    LibraryShare?.get().then(setConfig);
    listCustomCollections().then(setCollections).catch(() => setCollections([]));
  }, []);

  const save = useCallback(async (next: LibraryShareConfig) => {
    setConfig(next);
    setConfig(await LibraryShare!.set(next));
  }, []);

  if (!LibraryShare || !config) return null;

  const toggleOn = (enabled: boolean) =>
    // Turned on for the first time: the collections there are now, so it does something; the list below says which.
    save({ ...config, enabled, collections: enabled && !config.collections.length ? collections.map((c) => c.id) : config.collections });
  const toggleCollection = (id: string, on: boolean) =>
    save({ ...config, collections: on ? [...config.collections, id] : config.collections.filter((c) => c !== id) });
  const copy = async () => {
    await Clipboard.setStringAsync(await LibraryShare.clientConfig());
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const row = (key: string, label: string, value: string | null, on: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <View key={key} style={[styles.row, disabled && styles.disabled]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      </View>
      <Switch
        value={on}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ false: colors.border.default, true: colors.emerald[500] }}
      />
    </View>
  );

  return (
    <View style={styles.card}>
      {row("enabled", t("libraryShare.enabledLabel"), t("libraryShare.enabledValue"), config.enabled, toggleOn)}

      <Text style={styles.heading}>{t("libraryShare.visible")}</Text>
      {collections.map((c) =>
        row(c.id, c.name, t("libraryShare.docCount", { count: c.docCount }), config.collections.includes(c.id), (v) => toggleCollection(c.id, v), !config.enabled)
      )}
      {collections.length === 0 && <Text style={styles.note}>{t("libraryShare.noCollections")}</Text>}
      {row("builtin", t("libraryShare.builtinLabel"), t("libraryShare.builtinValue"), config.builtin, (v) => save({ ...config, builtin: v }), !config.enabled)}

      <Pressable style={styles.button} onPress={copy} accessibilityRole="button">
        <Text style={styles.buttonText}>{copied ? t("libraryShare.copied") : t("libraryShare.copyConfig")}</Text>
      </Pressable>
      <Text style={styles.note}>{t("libraryShare.note")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg.card, borderRadius: 10, padding: 14, margin: 12, gap: 12 },
  heading: { color: colors.text.heading, fontSize: 13, fontWeight: "600", marginTop: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  disabled: { opacity: 0.5 },
  rowLabel: { color: colors.text.primary, fontSize: 13, fontWeight: "600" },
  rowValue: { color: colors.text.muted, fontSize: 12, marginTop: 2 },
  button: { alignSelf: "flex-start", backgroundColor: colors.emerald[500], borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14 },
  buttonText: { color: colors.bg.card, fontSize: 13, fontWeight: "600" },
  note: { color: colors.text.dim, fontSize: 11, lineHeight: 16 },
});
