import React, { useCallback, useEffect, useState } from "react";
import { View, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from "react-native";
import { Text } from "./components/AppText";
import { impact, ImpactFeedbackStyle } from "../services/haptics";
import { useTranslation } from "react-i18next";
import {
  listRecentExecutions,
  clearExecutionTelemetry,
  exportExecutionTelemetry,
  ExecutionTelemetryRecord,
} from "../services/executionTelemetry";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";
import { EvaluationScreen } from "./EvaluationScreen";
import { MODEL_CATALOG } from "../models/manifest";
import { listDiscoveredModels } from "../models/discoveredModels";

interface Props {
  onClose?: () => void;
  chatBusy?: boolean;
}

function formatMs(ms: number | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatMB(bytes: number | undefined): string {
  if (bytes == null) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

function residencyIcon(residency: ExecutionTelemetryRecord["modelResidency"]): string {
  if (residency === "cold") return "🧊";
  if (residency === "switched") return "🔀";
  if (residency === "resident") return "♻️";
  return "—";
}

function outcomeColor(outcome: ExecutionTelemetryRecord["outcome"]): string {
  if (outcome === "failure") return colors.crimson[400];
  if (outcome === "cancelled") return colors.text.accentAmber ?? colors.amber[400];
  return colors.text.accentEmerald;
}

/**
 * Phase 7 (docs/ADAPTIVE_ROUTING.md) — dedicated diagnostic/comparison
 * screen for persisted execution_telemetry records (src/services/
 * executionTelemetry.ts). Deliberately NOT part of Settings — this is
 * engineering/debugging data for browsing and comparing runs across
 * models, not a user-facing preference. Kept simple: a scrollable list of
 * recent executions plus export, no charts/analytics.
 */
export function ExecutionTelemetryScreen({ onClose, chatBusy }: Props) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<ExecutionTelemetryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showEvaluation, setShowEvaluation] = useState(false);
  // Model id -> readable name; Hugging Face ids are long file-derived strings.
  const [modelLabels, setModelLabels] = useState<Record<string, string>>(
    () => Object.fromEntries(MODEL_CATALOG.map((m) => [m.id, m.label]))
  );

  useEffect(() => {
    listDiscoveredModels()
      .then((models) => setModelLabels((prev) => ({ ...prev, ...Object.fromEntries(models.map((m) => [m.id, m.label])) })))
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRecords(await listRecentExecutions(200));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleClose = () => {
    impact(ImpactFeedbackStyle.Light);
    onClose?.();
  };

  const handleExport = async (format: "json" | "csv") => {
    impact(ImpactFeedbackStyle.Light);
    setExporting(true);
    try {
      await exportExecutionTelemetry(format);
    } catch (e: any) {
      Alert.alert(t("executionTelemetry.exportFailedTitle"), e?.message ?? String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleClear = () => {
    Alert.alert(
      t("executionTelemetry.clearTitle"),
      t("executionTelemetry.clearMessage"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("executionTelemetry.clearConfirm"),
          style: "destructive",
          onPress: async () => {
            await clearExecutionTelemetry();
            await refresh();
          },
        },
      ]
    );
  };

  if (showEvaluation) {
    return (
      <EvaluationScreen
        chatBusy={chatBusy}
        onClose={() => {
          setShowEvaluation(false);
          refresh();
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View>
            <Text style={styles.headerTitle}>{t("executionTelemetry.title")}</Text>
            <Text style={styles.headerSubtitle}>{t("executionTelemetry.subtitle", { count: records.length })}</Text>
          </View>
        </View>
        <Pressable onPress={handleClose} hitSlop={8} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>{t("common.done")}</Text>
        </Pressable>
      </View>

      <View style={styles.actionsRow}>
        <Pressable style={styles.actionBtn} onPress={() => setShowEvaluation(true)}>
          <Text style={styles.actionBtnText}>{t("executionTelemetry.runEvaluation")}</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => handleExport("json")} disabled={exporting}>
          <Text style={styles.actionBtnText}>{t("executionTelemetry.exportJson")}</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => handleExport("csv")} disabled={exporting}>
          <Text style={styles.actionBtnText}>{t("executionTelemetry.exportCsv")}</Text>
        </Pressable>
        <Pressable style={[styles.actionBtn, styles.clearBtn]} onPress={handleClear}>
          <Text style={[styles.actionBtnText, styles.clearBtnText]}>{t("executionTelemetry.clear")}</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.emerald[400]} />
        </View>
      ) : records.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>{t("executionTelemetry.empty")}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {records.map((r) => (
            <View key={r.id} style={styles.row}>
              <View style={styles.rowHeader}>
                <Text style={styles.modelLabel} numberOfLines={1}>
                  {r.modelId ? modelLabels[r.modelId] ?? r.modelId : t("executionTelemetry.noModel")}
                </Text>
                <Text style={[styles.outcomeLabel, { color: outcomeColor(r.outcome) }]}>
                  {(r.outcome ?? "—").toUpperCase()}
                </Text>
              </View>
              <View style={styles.rowMeta}>
                <Text style={styles.metaText}>{r.taskType ?? "—"}</Text>
                <Text style={styles.metaDot}>•</Text>
                <Text style={styles.metaText}>
                  {residencyIcon(r.modelResidency)} {r.modelResidency ?? "n/a"}
                </Text>
                {r.adaptiveRoutingUsed && (
                  <>
                    <Text style={styles.metaDot}>•</Text>
                    <Text style={styles.metaText}>🧭 adaptive</Text>
                  </>
                )}
              </View>
              <View style={styles.statsGrid}>
                <StatCell label={t("executionTelemetry.tokPerSec")} value={r.tokPerSec ? `${r.tokPerSec.toFixed(1)} t/s` : "—"} />
                <StatCell label={t("executionTelemetry.loadTime")} value={formatMs(r.modelLoadMs)} />
                <StatCell label={t("executionTelemetry.ttft")} value={formatMs(r.ttftMs)} />
                <StatCell label={t("executionTelemetry.totalTime")} value={formatMs(r.totalLatencyMs)} />
                <StatCell label={t("executionTelemetry.memory")} value={formatMB(r.peakRssBytes)} />
                <StatCell label={t("executionTelemetry.tokens")} value={r.tokensGenerated != null ? `${r.tokensGenerated}` : "—"} />
              </View>
              <Text style={styles.timestamp}>{new Date(r.createdAt).toLocaleString()}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.surface },
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
  headerLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  closeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.xs,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  closeBtnText: { ...typography.mono.xs, color: colors.text.accentCyan, fontWeight: "800" },
  headerTitle: { ...typography.ui.titleSm, color: colors.text.heading, letterSpacing: 0.5 },
  headerSubtitle: { ...typography.mono.xs, fontSize: 9, color: colors.text.dim },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.bg.cardElevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    alignItems: "center",
  },
  actionBtnText: { ...typography.mono.xs, color: colors.text.accentCyan, fontWeight: "700" },
  clearBtn: { borderColor: colors.crimson.border, backgroundColor: colors.crimson.bgSubtle },
  clearBtnText: { color: colors.crimson[400] },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyText: { ...typography.ui.subtext, color: colors.text.dim, textAlign: "center" },
  scrollContent: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxxl },
  row: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.sm,
    gap: 6,
    marginBottom: spacing.sm,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modelLabel: { ...typography.ui.subtext, color: colors.text.heading, fontWeight: "700", flex: 1 },
  outcomeLabel: { ...typography.mono.xs, fontSize: 9, fontWeight: "800" },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { ...typography.mono.xs, fontSize: 10, color: colors.text.dim },
  metaDot: { color: colors.text.dim, fontSize: 10 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  statCell: { minWidth: 70 },
  statValue: { ...typography.mono.sm, color: colors.text.primary, fontWeight: "700", fontVariant: ["tabular-nums"] },
  statLabel: { ...typography.mono.xs, fontSize: 8, color: colors.text.dim },
  timestamp: { ...typography.mono.xs, fontSize: 8, color: colors.text.dim, textAlign: "right" },
});
