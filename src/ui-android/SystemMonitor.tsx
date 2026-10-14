import React, { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { Text } from "./components/AppText";
import { useTranslation } from "react-i18next";
import { ModelManager } from "../models/ModelManager";
import { RAM_BUDGET_BYTES, STORAGE_BUDGET_BYTES } from "../models/manifest";
import { getMemoryInfo, MemoryInfo } from "ram-monitor";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

const modelManager = new ModelManager();

function formatGB(bytes: number): string {
  if (bytes <= 0) return "0.00 GB";
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function Bar({
  label,
  usedBytes,
  budgetBytes,
  accentColor,
  exceededLabel,
}: {
  label: string;
  usedBytes: number;
  budgetBytes: number;
  accentColor: string;
  exceededLabel: string;
}) {
  const fraction = Math.min(usedBytes / budgetBytes, 1);
  const over = usedBytes > budgetBytes;

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text
          style={[
            styles.rowValue,
            over && styles.rowValueOver,
            !over && { color: accentColor },
          ]}
        >
          {formatGB(usedBytes)} / {formatGB(budgetBytes)}
          {over ? ` ${exceededLabel}` : ""}
        </Text>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${Math.max(fraction * 100, 2)}%`, backgroundColor: accentColor },
            over && styles.fillOver,
          ]}
        />
      </View>
    </View>
  );
}

export function SystemMonitor() {
  const { t } = useTranslation();
  const [storageBytes, setStorageBytes] = useState<number>(0);
  const [memInfo, setMemInfo] = useState<MemoryInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const used = await modelManager.currentStorageUsageBytes();
      if (!cancelled) setStorageBytes(used);

      try {
        const info = getMemoryInfo();
        if (!cancelled) setMemInfo(info);
      } catch {
        // Native module not linked
      }
    }

    poll();
    const id = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.icon}>📊</Text>
        <Text style={styles.title}>{t("systemMonitor.title")}</Text>
      </View>

      <Bar
        label={t("systemMonitor.diskLabel")}
        usedBytes={storageBytes}
        budgetBytes={STORAGE_BUDGET_BYTES}
        accentColor={colors.cyan[400]}
        exceededLabel={t("systemMonitor.exceeded")}
      />
      <Bar
        label={t("systemMonitor.ramLabel")}
        usedBytes={memInfo?.rssBytes ?? 0}
        budgetBytes={RAM_BUDGET_BYTES}
        accentColor={colors.emerald[400]}
        exceededLabel={t("systemMonitor.exceeded")}
      />

      {memInfo == null && (
        <Text style={styles.note}>{t("systemMonitor.noRssNote")}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginVertical: spacing.xs,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
    paddingBottom: spacing.xs,
  },
  icon: {
    fontSize: 13,
  },
  title: {
    ...typography.mono.xs,
    color: colors.text.heading,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  row: {
    gap: 4,
  },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowLabel: {
    ...typography.ui.caption,
    color: colors.text.secondary,
  },
  rowValue: {
    ...typography.mono.xs,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  rowValueOver: {
    color: colors.crimson[400],
  },
  track: {
    height: 8,
    borderRadius: radii.xs,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  fill: {
    height: "100%",
    borderRadius: radii.xs,
  },
  fillOver: {
    backgroundColor: colors.crimson[500],
  },
  note: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.dim,
    fontStyle: "italic",
  },
});
