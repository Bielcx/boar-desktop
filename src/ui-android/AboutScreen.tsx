import React from "react";
import { View, StyleSheet, Pressable, ScrollView, Image } from "react-native";
import { Text } from "./components/AppText";
import { impact, ImpactFeedbackStyle } from "../services/haptics";
import { useTranslation } from "react-i18next";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";
import appConfig from "../../app.json";

export function AboutScreen({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const handleClose = () => {
    impact(ImpactFeedbackStyle.Light);
    onClose();
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>{t("aboutScreen.title")}</Text>
        </View>
        <Pressable onPress={handleClose} hitSlop={8} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>{t("common.done")}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.heroBox}>
          <Image
            source={require("../../assets/boar.png")}
            style={styles.mascotImg}
            resizeMode="contain"
          />
          <Text style={styles.heroTitle}>BOAR</Text>
          <Text style={styles.heroSubtitle}>{t("aboutScreen.heroSubtitle")}</Text>
          <View style={styles.versionBadge}>
            <Text style={styles.versionText}>
              {t("aboutScreen.versionBadge", {
                version: appConfig.expo.version,
                build: __DEV__ ? t("aboutScreen.buildDevelopment") : t("aboutScreen.buildRelease"),
              })}
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("aboutScreen.airGappedTitle")}</Text>
          <Text style={styles.paragraph}>{t("aboutScreen.airGappedBody")}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("aboutScreen.hardwareTitle")}</Text>
          <Text style={styles.paragraph}>{t("aboutScreen.hardwareBody")}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("aboutScreen.benchmarkTitle")}</Text>
          <Text style={styles.paragraph}>{t("aboutScreen.benchmarkBody")}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("aboutScreen.repoTitle")}</Text>
          <Text style={styles.paragraph}>{t("aboutScreen.repoBody")}</Text>
          <View style={styles.repoBox}>
            <Text style={styles.repoText}>github.com/rferrari/boar-app</Text>
          </View>
        </View>
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
  body: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxxl },
  heroBox: {
    alignItems: "center",
    paddingVertical: spacing.md,
    gap: 4,
  },
  mascotImg: {
    width: 64,
    height: 64,
    borderRadius: 14,
    marginBottom: 4,
  },
  heroTitle: {
    ...typography.ui.headline,
    color: colors.text.heading,
  },
  heroSubtitle: {
    ...typography.mono.xs,
    color: colors.text.accentEmerald,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  versionBadge: {
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.xs,
    marginTop: 4,
  },
  versionText: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.dim,
  },
  card: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.md,
    gap: 6,
  },
  cardTitle: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  paragraph: {
    ...typography.ui.body,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  repoBox: {
    backgroundColor: colors.bg.terminal,
    borderRadius: radii.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  repoText: {
    ...typography.mono.xs,
    color: colors.text.accentEmerald,
  },
});
