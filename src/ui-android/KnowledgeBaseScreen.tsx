import React from "react";
import { View, StyleSheet, Pressable, ScrollView, FlatList } from "react-native";
import { Text } from "./components/AppText";
import { impact, ImpactFeedbackStyle } from "../services/haptics";
import { useTranslation } from "react-i18next";
import { PersonalDocumentsManager } from "./PersonalDocumentsManager";
import type { CustomCollection } from "../rag/db";
import { CORPUS_CATALOG, type CatalogModel } from "../models/manifest";
import { startDownload, getDownloadState } from "../services/downloadManager";
import { seedKnowledgeBaseIfEmpty } from "../rag/seedCorpus";
import { closePack } from "../rag/packs";
import { CatalogItemCard } from "./CatalogItemCard";
import { useCatalogRows } from "./useCatalogRows";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

/**
 * Knowledge: everything BOAR answers from, in one place (as the native app): the topic packs to download and the
 * user's own documents. Settings > Offline Knowledge Base links here.
 */
export function KnowledgeBaseScreen({ onClose, onAsk }: { onClose: () => void; onAsk?: (collection: CustomCollection) => void }) {
  const { t } = useTranslation();
  const { getRow, refresh, deleteModel } = useCatalogRows(CORPUS_CATALOG);
  const download = async (pack: CatalogModel) => {
    impact(ImpactFeedbackStyle.Medium);
    await startDownload(pack);
    await refresh();
    if (!getDownloadState(pack.id)?.error) await seedKnowledgeBaseIfEmpty();
  };
  const remove = async (pack: CatalogModel) => {
    if (pack.format === "sqlite-pack") await closePack(pack.id);
    await deleteModel(pack);
    await refresh();
  };
  const handleClose = () => {
    impact(ImpactFeedbackStyle.Light);
    onClose();
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>{t("knowledgeBaseScreen.title")}</Text>
        </View>
        <Pressable onPress={handleClose} hitSlop={8} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>{t("common.done")}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.sectionHeading}>{t("flows.knowledge.topicPacksTitle")}</Text>
        <Text style={styles.sectionNote}>{t("flows.knowledge.topicPacksFooter")}</Text>
        <FlatList
          data={CORPUS_CATALOG}
          keyExtractor={(m) => m.id}
          scrollEnabled={false}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <CatalogItemCard item={item} row={getRow(item)} isActive={getRow(item).present} onDownload={download} onUse={() => {}} onRemove={remove} />
          )}
        />
        <Text style={styles.sectionHeading}>{t("corpusSettingsTab.yourDocuments")}</Text>
        <PersonalDocumentsManager onAsk={onAsk} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.surface },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
    backgroundColor: colors.bg.cardElevated,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    ...typography.ui.titleSm,
    color: colors.text.heading,
  },
  closeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.xs,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  closeBtnText: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "800",
  },
  body: { paddingBottom: spacing.xxxl },
  sectionHeading: { ...typography.ui.titleSm, color: colors.text.heading, marginHorizontal: 12, marginTop: 14 },
  sectionNote: { color: colors.text.muted, fontSize: 12, lineHeight: 17, marginHorizontal: 12, marginTop: 2 },
  list: { padding: 12, gap: 10 },
});
