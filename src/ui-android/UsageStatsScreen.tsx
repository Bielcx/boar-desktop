import React from "react";
import { View, StyleSheet, Pressable, ScrollView } from "react-native";
import { Text } from "./components/AppText";
import { impact, ImpactFeedbackStyle } from "../services/haptics";
import { useTranslation } from "react-i18next";
import { UsageStatsContent } from "./UsageStatsContent";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

interface Props {
  onClose?: () => void;
}

/**
 * Fullscreen Hardware Telemetry & System Dashboard for field audit and compliance verification.
 */
export function UsageStatsScreen({ onClose }: Props) {
  const { t } = useTranslation();
  const handleClose = () => {
    impact(ImpactFeedbackStyle.Light);
    onClose?.();
  };

  return (
    <View style={styles.container}>
      {/* Top Header */}
      <View style={styles.header}>
        {onClose ? (
          <Pressable style={styles.backBtn} onPress={handleClose} hitSlop={8}>
            <Text style={styles.backBtnText}>{t("usageStatsScreen.back")}</Text>
          </Pressable>
        ) : (
          <View style={{ width: 40 }} />
        )}
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("usageStatsScreen.title")}</Text>
          <Text style={styles.headerSubtitle}>{t("usageStatsScreen.subtitle")}</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={styles.liveIndicator}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{t("usageStatsScreen.live")}</Text>
          </View>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <UsageStatsContent />
      </ScrollView>
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
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.dim,
  },
  headerRight: {
    minWidth: 40,
    alignItems: "flex-end",
  },
  liveIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald.border,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.xs,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.emerald[400],
  },
  liveText: {
    ...typography.mono.xs,
    fontSize: 8,
    fontWeight: "800",
    color: colors.text.accentEmerald,
  },
  scrollContent: {
    paddingBottom: spacing.xxxl,
  },
});
