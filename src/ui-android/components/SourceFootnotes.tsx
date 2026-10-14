import React, { useState } from "react";
import { View, StyleSheet, Pressable } from "react-native";
import { Text } from "./AppText";
import { impact, ImpactFeedbackStyle } from "../../services/haptics";
import { useTranslation } from "react-i18next";
import { RetrievedChunk } from "../../rag/retrieve";
import { colors } from "../theme/colors";
import { typography } from "../theme/typography";
import { spacing, radii } from "../theme/spacing";

interface Props {
  citations: RetrievedChunk[];
}

export function SourceFootnotes({ citations }: Props) {
  const { t } = useTranslation();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  if (!citations || citations.length === 0) return null;

  const toggle = (idx: number) => {
    impact(ImpactFeedbackStyle.Light);
    setExpandedIndex(expandedIndex === idx ? null : idx);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerIcon}>📚</Text>
          <Text style={styles.headerTitle}>{t("sourceFootnotes.title")}</Text>
        </View>
        <Text style={styles.sourceCountBadge}>{citations.length}</Text>
      </View>

      <View style={styles.chipsRow}>
        {citations.map((c, i) => {
          const isExpanded = expandedIndex === i;
          return (
            <View key={i} style={styles.cardWrapper}>
              <Pressable
                style={[styles.chip, isExpanded && styles.chipActive]}
                onPress={() => toggle(i)}
                hitSlop={4}
              >
                <View style={styles.chipIndexPill}>
                  <Text style={styles.chipIndexText}>{i + 1}</Text>
                </View>
                <Text style={styles.chipTitle} numberOfLines={1}>
                  {c.title}
                </Text>
                {/* The real similarity to the question, not the fused score: that one is only
                    relative (the best chunk always read ~100%, even when it was unrelated). */}
                {c.similarity != null && (
                  <Text style={styles.scoreText}>{(c.similarity * 100).toFixed(0)}%</Text>
                )}
                <Text style={styles.expandChevron}>{isExpanded ? "▲" : "▼"}</Text>
              </Pressable>

              {isExpanded && (
                <View style={styles.snippetBox}>
                  <View style={styles.snippetMeta}>
                    <Text style={styles.snippetPackTag}>{t("sourceFootnotes.localIndex")}</Text>
                    <Text style={styles.snippetDocId} numberOfLines={1}>
                      {c.docId || c.title}
                    </Text>
                  </View>
                  <Text style={styles.snippetText} numberOfLines={6}>
                    {c.body}
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.sm,
    paddingTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.08)",
    gap: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  headerIcon: {
    fontSize: 11,
  },
  headerTitle: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  sourceCountBadge: {
    ...typography.mono.xs,
    color: colors.text.muted,
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.xs,
  },
  chipsRow: {
    gap: 6,
  },
  cardWrapper: {
    gap: 4,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.8)",
    borderColor: colors.border.default,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 6,
  },
  chipActive: {
    borderColor: colors.cyan[500],
    backgroundColor: "rgba(6, 182, 212, 0.1)",
  },
  chipIndexPill: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.cyan.bgSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  chipIndexText: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "700",
    fontSize: 9,
  },
  chipTitle: {
    ...typography.ui.caption,
    color: colors.text.heading,
    flex: 1,
    fontWeight: "600",
  },
  scoreText: {
    ...typography.mono.xs,
    color: colors.text.accentEmerald,
    fontWeight: "600",
  },
  expandChevron: {
    fontSize: 8,
    color: colors.text.dim,
  },
  snippetBox: {
    backgroundColor: colors.bg.terminal,
    borderColor: colors.border.default,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: 4,
  },
  snippetMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  snippetPackTag: {
    ...typography.mono.xs,
    color: colors.text.accentEmerald,
    fontWeight: "700",
  },
  snippetDocId: {
    ...typography.mono.xs,
    color: colors.text.dim,
    flex: 1,
    textAlign: "right",
  },
  snippetText: {
    ...typography.mono.xs,
    color: colors.text.secondary,
    lineHeight: 16,
  },
});
