import React, { useCallback, useEffect, useState } from "react";
import { View, StyleSheet, Pressable, FlatList, ActivityIndicator, Alert } from "react-native";
import { colors } from "./theme/colors";
import { Text, TextInput } from "./components/AppText";
import { useTranslation } from "react-i18next";
import { searchModels, listGgufFiles, toCatalogModel, formatParams, HF_SIZES, HF_SORTS, HFModelSummary, HFGgufFile, HFSize, HFSort } from "../services/modelBrowser";
import { addDiscoveredModel } from "../models/discoveredModels";
import { useNetworkState } from "expo-network";
import { isOnline } from "../services/connectivity.pure";

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
    : `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

interface Props {
  /** Called after a model is added to the discovered list, so the parent can refresh its own list/status. */
  onAdded: () => void;
}

/**
 * Search Hugging Face for GGUF models not in the app's curated MODEL_CATALOG.
 * Adding a result here just registers it (src/models/discoveredModels.ts) —
 * the actual download happens through the normal CatalogItemCard flow in the
 * Tone & Model list above, so it gets the same progress tracking, size
 * verification, and duplicate-download guard as every other model.
 */
export function ModelBrowser({ onAdded }: Props) {
  const online = isOnline(useNetworkState());
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [size, setSize] = useState<HFSize>("any");
  const [sort, setSort] = useState<HFSort>("trending");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<HFModelSummary[]>([]);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);
  const [filesByRepo, setFilesByRepo] = useState<Record<string, HFGgufFile[]>>({});
  const [filesLoading, setFilesLoading] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const runSearch = useCallback(async (next: { size?: HFSize; sort?: HFSort } = {}) => {
    if (!online) return;
    setSearching(true);
    setExpandedRepo(null);
    try {
      setResults(await searchModels(query, next.size ?? size, next.sort ?? sort));
    } catch (e: any) {
      Alert.alert(t("modelBrowser.searchFailedTitle"), e?.message ?? String(e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [online, query, size, sort, t]);

  // Opening the page browses what's trending; nothing is asked of Hugging Face before that.
  useEffect(() => {
    runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const chips = <K extends string>(label: string, options: readonly K[], value: K, pick: (k: K) => void, name: (k: K) => string) => (
    <View style={[styles.chipRow, !online && styles.disabled]}>
      <Text style={styles.chipLabel}>{label}</Text>
      {options.map((k) => (
        <Pressable key={k} disabled={!online} onPress={() => pick(k)} style={[styles.chip, value === k && styles.chipOn]}>
          <Text style={[styles.chipText, value === k && styles.chipTextOn]}>{name(k)}</Text>
        </Pressable>
      ))}
    </View>
  );

  const toggleRepo = useCallback(
    async (repoId: string) => {
      if (expandedRepo === repoId) {
        setExpandedRepo(null);
        return;
      }
      setExpandedRepo(repoId);
      if (!filesByRepo[repoId]) {
        setFilesLoading(repoId);
        try {
          const files = await listGgufFiles(repoId);
          setFilesByRepo((prev) => ({ ...prev, [repoId]: files }));
        } catch (e: any) {
          Alert.alert(t("modelBrowser.loadFilesFailedTitle"), e?.message ?? String(e));
          setExpandedRepo(null);
        } finally {
          setFilesLoading(null);
        }
      }
    },
    [expandedRepo, filesByRepo, t]
  );

  const addFile = useCallback(
    async (repoId: string, file: HFGgufFile) => {
      const key = `${repoId}/${file.filename}`;
      setAddingKey(key);
      try {
        const model = toCatalogModel(repoId, file);
        await addDiscoveredModel(model);
        onAdded();
        Alert.alert(t("modelBrowser.addedTitle"), t("modelBrowser.addedMessage", { label: model.label }));
      } catch (e: any) {
        Alert.alert(t("modelBrowser.addFailedTitle"), e?.message ?? String(e));
      } finally {
        setAddingKey(null);
      }
    },
    [onAdded, t]
  );

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>{t("modelBrowser.hint")}</Text>
      {/* The phone's own network state (no request): searching needs the internet, nothing else does. */}
      {!online && <Text style={styles.offlineNote}>{t("modelBrowser.offlineNote")}</Text>}
      <View style={[styles.searchRow, !online && styles.disabled]}>
        <TextInput
          editable={online}
          style={styles.input}
          placeholder={t("modelBrowser.searchPlaceholder")}
          placeholderTextColor={colors.text.dim}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => runSearch()}
          returnKeyType="search"
        />
        <Pressable style={styles.searchBtn} onPress={() => runSearch()} disabled={searching || !online}>
          {searching ? <ActivityIndicator color={colors.text.heading} /> : <Text style={styles.searchBtnText}>🔎</Text>}
        </Pressable>
      </View>
      {chips(t("modelBrowser.size"), Object.keys(HF_SIZES) as HFSize[], size, (k) => (setSize(k), runSearch({ size: k })), (k) => t(`modelBrowser.sizes.${k}`))}
      {chips(t("modelBrowser.sort"), Object.keys(HF_SORTS) as HFSort[], sort, (k) => (setSort(k), runSearch({ sort: k })), (k) => t(`modelBrowser.sorts.${k}`))}

      <FlatList
        data={results}
        keyExtractor={(m) => m.id}
        scrollEnabled={false}
        contentContainerStyle={{ gap: 8, marginTop: 8 }}
        renderItem={({ item }) => (
          <View style={styles.repoCard}>
            <Pressable onPress={() => toggleRepo(item.id)}>
              <Text style={styles.repoId}>{item.id}</Text>
              <Text style={styles.repoMeta}>
                {item.params ? `${formatParams(item.params)} · ` : ""}
                {t("modelBrowser.downloadsLikes", {
                  downloads: item.downloads?.toLocaleString() ?? "?",
                  likes: item.likes ?? 0,
                })}
              </Text>
            </Pressable>

            {expandedRepo === item.id && filesLoading === item.id && (
              <ActivityIndicator color={colors.text.accentEmerald} style={{ marginTop: 8 }} />
            )}

            {expandedRepo === item.id &&
              filesLoading !== item.id &&
              (filesByRepo[item.id] ?? []).map((file) => {
                const key = `${item.id}/${file.filename}`;
                return (
                  <View key={key} style={styles.fileRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fileName}>{file.filename}</Text>
                      <Text style={styles.fileMeta}>
                        {formatBytes(file.sizeBytes)}
                        {!file.sha256 ? ` · ${t("modelBrowser.noChecksum")}` : ""}
                      </Text>
                    </View>
                    <Pressable
                      style={styles.addBtn}
                      disabled={addingKey === key}
                      onPress={() => addFile(item.id, file)}
                    >
                      <Text style={styles.addBtnText}>
                        {addingKey === key ? t("modelBrowser.adding") : t("modelBrowser.addButton")}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}

            {expandedRepo === item.id && filesLoading !== item.id && (filesByRepo[item.id]?.length ?? 0) === 0 && (
              <Text style={styles.fileMeta}>{t("modelBrowser.noGgufFiles")}</Text>
            )}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 4 },
  hint: { color: colors.text.muted, fontSize: 11, marginBottom: 8, lineHeight: 16 },
  searchRow: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    backgroundColor: colors.bg.cardHover,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.text.primary,
    fontSize: 13,
  },
  offlineNote: { color: colors.text.accentAmber, fontSize: 12, lineHeight: 17 },
  disabled: { opacity: 0.4 },
  searchBtn: {
    backgroundColor: colors.emerald[600],
    borderRadius: 6,
    paddingHorizontal: 14,
    justifyContent: "center",
  },
  searchBtnText: { fontSize: 15 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 },
  chipLabel: { color: colors.text.muted, fontSize: 11, marginRight: 2 },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 10, paddingVertical: 4 },
  chipOn: { backgroundColor: colors.emerald.bgSubtle, borderColor: colors.emerald.border },
  chipText: { color: colors.text.muted, fontSize: 11 },
  chipTextOn: { color: colors.text.accentEmerald, fontWeight: "600" },
  repoCard: {
    backgroundColor: colors.bg.card,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  repoId: { color: colors.text.primary, fontSize: 13, fontWeight: "600" },
  repoMeta: { color: colors.text.accentEmerald, fontSize: 11, marginTop: 2 },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  fileName: { color: colors.text.primary, fontSize: 12 },
  fileMeta: { color: colors.text.muted, fontSize: 10, marginTop: 2 },
  addBtn: { backgroundColor: colors.cyan.bgSubtle, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  addBtnText: { color: colors.text.accentCyan, fontSize: 11, fontWeight: "600" },
});
