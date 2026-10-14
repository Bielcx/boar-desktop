import React, { useCallback, useEffect, useState } from "react";
import { View, StyleSheet, FlatList, Pressable, ScrollView } from "react-native";
import { Text } from "./components/AppText";
import { impact, ImpactFeedbackStyle } from "../services/haptics";
import { useTranslation } from "react-i18next";
import { MODEL_CATALOG, CatalogModel, AssetKind } from "../models/manifest";
import { ModelManager } from "../models/ModelManager";
import { getActiveModelId, setActiveModelId } from "../models/settings";
import {
  startDownload,
  getDownloadState,
  isDownloading,
  subscribeDownloads,
} from "../services/downloadManager";
import { listDiscoveredModels, removeDiscoveredModel } from "../models/discoveredModels";
import { CatalogItemCard, CatalogRowState } from "./CatalogItemCard";
import { ModelBrowser } from "./ModelBrowser";
import { Toast } from "./Toast";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

const modelManager = new ModelManager();
const FILTER_TABS = ["all", "llm", "corpus", "community"] as const;
type FilterTab = (typeof FILTER_TABS)[number];

interface Props {
  onClose?: () => void;
}

export function ModelCatalogScreen({ onClose }: Props) {
  const { t } = useTranslation();
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [activeIds, setActiveIds] = useState<Partial<Record<AssetKind, string>>>({});
  const [discoveredModels, setDiscoveredModels] = useState<CatalogModel[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<FilterTab>("all");
  const [toast, setToast] = useState<string | null>(null);
  const [, forceRender] = useState(0);

  useEffect(() => subscribeDownloads(() => forceRender((n) => n + 1)), []);

  const refreshDiscovered = useCallback(async () => {
    const models = await listDiscoveredModels();
    setDiscoveredModels(models);
    const statuses = await Promise.all(models.map((m) => modelManager.statusOf(m)));
    setPresence((prev) => ({
      ...prev,
      ...Object.fromEntries(statuses.map((s) => [s.asset.id, s.present])),
    }));
  }, []);

  const refreshStatus = useCallback(async () => {
    const statuses = await modelManager.statusAll();
    setPresence(Object.fromEntries(statuses.map((s) => [s.asset.id, s.present])));
    await refreshDiscovered();

    const next: Partial<Record<AssetKind, string>> = {};
    for (const kind of ["llm", "embedding"] as AssetKind[]) {
      const active = await getActiveModelId(kind);
      next[kind] = active ?? MODEL_CATALOG.find((m) => m.kind === kind && m.required)?.id;
    }
    setActiveIds(next);
  }, [refreshDiscovered]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const getRow = useCallback(
    (item: CatalogModel): CatalogRowState => {
      const dl = getDownloadState(item.id);
      return {
        present: presence[item.id] ?? false,
        downloading: isDownloading(item.id),
        progress: dl?.progress ?? 0,
        error: dl?.error ?? null,
        bytesWritten: dl?.bytesWritten,
        bytesExpected: dl?.bytesExpected,
        speedBytesPerSec: dl?.speedBytesPerSec,
        etaSeconds: dl?.etaSeconds,
      };
    },
    [presence]
  );

  const download = useCallback(
    async (model: CatalogModel) => {
      impact(ImpactFeedbackStyle.Medium);
      await startDownload(model);
      await refreshStatus();
    },
    [refreshStatus]
  );

  const remove = useCallback(
    async (model: CatalogModel) => {
      await modelManager.deleteModel(model);
      if (model.id.startsWith("hf-")) {
        await removeDiscoveredModel(model.id);
      }
      await refreshStatus();
      setToast(t("modelCatalogScreen.removedToast", { label: model.label }));
    },
    [refreshStatus, t]
  );

  const useModel = useCallback(
    async (model: CatalogModel) => {
      impact(ImpactFeedbackStyle.Light);
      await setActiveModelId(model.kind, model.id);
      await refreshStatus();
      setToast(t("modelCatalogScreen.activeModelToast", { kind: model.kind, label: model.label }));
    },
    [refreshStatus, t]
  );

  const allModels = [...MODEL_CATALOG, ...discoveredModels];
  const filteredModels = allModels.filter((m) => {
    if (selectedFilter === "all") return true;
    if (selectedFilter === "llm") return m.kind === "llm";
    if (selectedFilter === "corpus") return m.kind === "corpus";
    if (selectedFilter === "community") return m.id.startsWith("hf-");
    return true;
  });

  return (
    <View style={styles.container}>
      {/* Top Header */}
      <View style={styles.header}>
        {onClose ? (
          <Pressable style={styles.backBtn} onPress={onClose} hitSlop={8}>
            <Text style={styles.backBtnText}>‹ {t("common.back")}</Text>
          </Pressable>
        ) : (
          <View style={{ width: 40 }} />
        )}
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("modelCatalogScreen.title")}</Text>
          <Text style={styles.headerSubtitle}>{t("modelCatalogScreen.subtitle")}</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      {/* Filter Tabs */}
      <View style={styles.tabsRow}>
        {FILTER_TABS.map((tab) => {
          const isSelected = selectedFilter === tab;
          return (
            <Pressable
              key={tab}
              style={[styles.tabBtn, isSelected && styles.tabBtnActive]}
              onPress={() => {
                impact(ImpactFeedbackStyle.Light);
                setSelectedFilter(tab);
              }}
            >
              <Text style={[styles.tabBtnText, isSelected && styles.tabBtnTextActive]}>
                {t(`modelCatalogScreen.filters.${tab}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={filteredModels}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <CatalogItemCard
            item={item}
            row={getRow(item)}
            isActive={activeIds[item.kind] === item.id}
            onDownload={download}
            onUse={useModel}
            onRemove={remove}
          />
        )}
        ListFooterComponent={
          selectedFilter === "community" || selectedFilter === "all" ? (
            <View style={styles.browserContainer}>
              <View style={styles.browserHeader}>
                <Text style={styles.browserIcon}>🌐</Text>
                <Text style={styles.browserTitle}>{t("modelCatalogScreen.browserSectionTitle")}</Text>
              </View>
              <ModelBrowser onAdded={refreshStatus} />
            </View>
          ) : null
        }
      />

      {toast && <Toast message={toast} onHide={() => setToast(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.surface,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
    backgroundColor: colors.bg.cardElevated,
  },
  backBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.xs,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  backBtnText: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "700",
  },
  headerCenter: {
    alignItems: "center",
  },
  headerTitle: {
    ...typography.ui.titleSm,
    color: colors.text.heading,
  },
  headerSubtitle: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.dim,
  },
  tabsRow: {
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  tabBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.sm,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  tabBtnActive: {
    backgroundColor: colors.cyan.bgSubtle,
    borderColor: colors.cyan.border,
    borderWidth: 1,
  },
  tabBtnText: {
    ...typography.mono.xs,
    color: colors.text.dim,
    fontWeight: "700",
  },
  tabBtnTextActive: {
    color: colors.text.accentCyan,
  },
  listContent: {
    padding: spacing.md,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  browserContainer: {
    marginTop: spacing.lg,
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.default,
    gap: spacing.sm,
  },
  browserHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
    paddingBottom: spacing.xs,
  },
  browserIcon: {
    fontSize: 14,
  },
  browserTitle: {
    ...typography.mono.xs,
    color: colors.text.heading,
    fontWeight: "800",
  },
});
