import React, { useCallback, useEffect, useState } from "react";
import { View, StyleSheet, Pressable, Switch, Alert, ActivityIndicator } from "react-native";
import { colors } from "./theme/colors";
import { Text, TextInput } from "./components/AppText";
import { useTranslation } from "react-i18next";
import {
  pickDocuments,
  importDocuments,
  exportCollection,
  listCustomCollections,
  setCustomCollectionActive,
  deleteCustomCollection,
  ImportProgress,
} from "../services/documentImporter";
import { CustomCollection } from "../rag/db";

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
}

/**
 * Import, list, toggle, export, and delete the user's own document
 * collections (see src/services/documentImporter.ts) — fully self-contained
 * (one optional prop), shown on the Knowledge screen (KnowledgeBaseScreen)
 * below the downloadable topic packs.
 */
export function PersonalDocumentsManager({ onAsk }: { onAsk?: (collection: CustomCollection) => void } = {}) {
  const { t } = useTranslation();
  // The collection just imported, until the user asks about it or imports another: "Ask about it now".
  const [justImported, setJustImported] = useState<CustomCollection | null>(null);
  const [collections, setCollections] = useState<CustomCollection[]>([]);
  const [newName, setNewName] = useState("");
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setCollections(await listCustomCollections());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleImport = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      Alert.alert(t("personalDocumentsManager.nameRequiredTitle"), t("personalDocumentsManager.nameRequiredMessage"));
      return;
    }
    const files = await pickDocuments();
    if (!files || files.length === 0) return;

    setImportProgress({ stage: "reading" });
    try {
      setJustImported(await importDocuments(files, name, setImportProgress));
      setNewName("");
      await refresh();
    } catch (e: any) {
      Alert.alert(t("personalDocumentsManager.importFailedTitle"), e?.message ?? String(e));
    } finally {
      setImportProgress(null);
    }
  }, [newName, refresh]);

  const handleToggle = useCallback(
    async (collection: CustomCollection, active: boolean) => {
      await setCustomCollectionActive(collection.id, active);
      await refresh();
    },
    [refresh]
  );

  const handleDelete = useCallback(
    (collection: CustomCollection) => {
      Alert.alert(
        t("personalDocumentsManager.removeConfirmTitle"),
        t("personalDocumentsManager.removeConfirmMessage", { name: collection.name, count: collection.chunkCount }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("common.remove"),
            style: "destructive",
            onPress: async () => {
              await deleteCustomCollection(collection.id);
              await refresh();
            },
          },
        ]
      );
    },
    [refresh]
  );

  const handleExport = useCallback(async (collection: CustomCollection) => {
    setBusyId(collection.id);
    try {
      await exportCollection(collection);
    } catch (e: any) {
      Alert.alert(t("personalDocumentsManager.exportFailedTitle"), e?.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.hint}>{t("personalDocumentsManager.hint")}</Text>

      <View style={styles.importCard}>
        <TextInput
          style={styles.nameInput}
          placeholder={t("personalDocumentsManager.namePlaceholder")}
          placeholderTextColor={colors.text.dim}
          value={newName}
          onChangeText={setNewName}
          editable={!importProgress}
        />
        <Pressable
          style={[styles.importBtn, !!importProgress && styles.importBtnDisabled]}
          onPress={handleImport}
          disabled={!!importProgress}
        >
          {importProgress ? (
            <ActivityIndicator color={colors.text.heading} />
          ) : (
            <Text style={styles.importBtnText}>📄 {t("personalDocumentsManager.pickButton")}</Text>
          )}
        </Pressable>
        {importProgress && (
          <Text style={styles.progressText}>
            {importProgress.stage === "reading" && t("personalDocumentsManager.stageReading")}
            {importProgress.stage === "chunking" && t("personalDocumentsManager.stageChunking")}
            {importProgress.stage === "embedding" &&
              t("personalDocumentsManager.stageEmbedding", {
                current: (importProgress.chunkIndex ?? 0) + 1,
                total: importProgress.chunkCount,
              })}
          </Text>
        )}
      </View>

      {onAsk && justImported && !importProgress && (
        <View style={styles.askNowCard}>
          <Text style={styles.askNowText}>{t("personalDocumentsManager.imported", { name: justImported.name })}</Text>
          <Pressable style={styles.importBtn} onPress={() => onAsk(justImported)} accessibilityRole="button">
            <Text style={styles.importBtnText}>💬 {t("personalDocumentsManager.askNow")}</Text>
          </Pressable>
        </View>
      )}

      {collections.length === 0 && !importProgress && (
        <Text style={styles.empty}>{t("personalDocumentsManager.empty")}</Text>
      )}

      <View style={styles.list}>
        {collections.map((c) => (
          <View key={c.id} style={[styles.collectionCard, !c.active && styles.collectionCardInactive]}>
            <View style={styles.collectionHeaderRow}>
              <Text style={styles.collectionName}>{c.name}</Text>
              <Switch value={c.active} onValueChange={(v) => handleToggle(c, v)} />
            </View>
            <Text style={styles.collectionMeta}>
              {t("personalDocumentsManager.docCount", { count: c.docCount })} · {" "}
              {t("personalDocumentsManager.chunkCount", { count: c.chunkCount })} · {formatBytes(c.sizeBytes)}
            </Text>
            <View style={styles.collectionActions}>
              {onAsk && (
                <Pressable onPress={() => onAsk(c)} style={styles.askBtn} accessibilityRole="button">
                  <Text style={styles.askBtnText}>💬 {t("personalDocumentsManager.askButton")}</Text>
                </Pressable>
              )}
              <Pressable onPress={() => handleExport(c)} disabled={busyId === c.id} style={styles.exportBtn}>
                <Text style={styles.exportBtnText}>
                  {busyId === c.id
                    ? t("personalDocumentsManager.exporting")
                    : `📤 ${t("personalDocumentsManager.exportButton")}`}
                </Text>
              </Pressable>
              <Pressable onPress={() => handleDelete(c)} hitSlop={8} style={styles.trashBtn}>
                <Text style={styles.trashIcon}>🗑️</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { color: colors.text.muted, fontSize: 11, marginHorizontal: 12, marginTop: 4, lineHeight: 16 },
  list: { padding: 12, gap: 10 },
  importCard: {
    marginHorizontal: 12,
    marginTop: 10,
    backgroundColor: colors.bg.card,
    borderRadius: 10,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  nameInput: {
    backgroundColor: colors.bg.cardHover,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.text.primary,
    fontSize: 13,
  },
  importBtn: {
    backgroundColor: colors.emerald[600],
    borderRadius: 6,
    paddingVertical: 10,
    alignItems: "center",
  },
  importBtnDisabled: { backgroundColor: colors.border.default },
  importBtnText: { color: colors.text.heading, fontWeight: "700", fontSize: 13 },
  progressText: { color: colors.text.accentEmerald, fontSize: 11, textAlign: "center" },
  empty: { color: colors.text.dim, fontSize: 12, marginHorizontal: 12, marginTop: 8 },
  collectionCard: {
    backgroundColor: colors.bg.card,
    borderRadius: 10,
    padding: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  collectionCardInactive: { opacity: 0.55 },
  collectionHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  collectionName: { color: colors.text.primary, fontSize: 14, fontWeight: "600", flex: 1 },
  collectionMeta: { color: colors.text.accentEmerald, fontSize: 11 },
  collectionActions: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  exportBtn: { backgroundColor: colors.cyan.bgSubtle, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  exportBtnText: { color: colors.text.accentCyan, fontSize: 12, fontWeight: "600" },
  askBtn: { backgroundColor: colors.emerald.bgSubtle, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  askBtnText: { color: colors.text.accentEmerald, fontSize: 12, fontWeight: "600" },
  askNowCard: { marginHorizontal: 12, marginTop: 8, padding: 12, gap: 8, borderRadius: 10, borderWidth: 1, borderColor: colors.emerald.border, backgroundColor: colors.emerald.bgSubtle },
  askNowText: { color: colors.text.primary, fontSize: 13 },
  trashBtn: { marginLeft: "auto", padding: 4 },
  trashIcon: { fontSize: 15 },
});
