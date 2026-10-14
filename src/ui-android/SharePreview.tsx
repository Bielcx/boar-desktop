import React, { useMemo, useState } from "react";
import { Modal, View, StyleSheet, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "./components/AppText";
import { useTranslation } from "react-i18next";
import type { EvalResultRow } from "../eval/evalHarness.pure";
import { describeChipset, describeCores, inferenceFeatures, type ShareDevice } from "../eval/shareResults.pure";
import { scoreRun, SCORE_VERSION, REFERENCE_TOK_PER_SEC, WEIGHTS } from "../eval/score.pure";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

interface Props {
  visible: boolean;
  rows: EvalResultRow[];
  device: ShareDevice;
  appVersion: string;
  sending: boolean;
  onCancel: () => void;
  onShare: () => void;
  /** Once the user pressed Share: the progress screen, shown in place of the preview. */
  progress?: React.ReactElement | null;
}

const gb = (bytes: number | undefined) => (bytes && bytes > 0 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "—");
const secs = (ms: number | undefined) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const pct = (x: number | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

/**
 * Everything a shared run carries, shown before anything is sent: the phone and its CPU, each
 * model's score with the raw numbers behind it, and every question and answer. The score shown
 * here is the app's copy of the formula (src/eval/score.pure.ts); the server recomputes it.
 */
export function SharePreview({ visible, rows, device, appVersion, sending, onCancel, onShare, progress }: Props) {
  const { t } = useTranslation();
  const [showAnswers, setShowAnswers] = useState(false);
  const scores = useMemo(() => scoreRun(rows), [rows]);
  const features = inferenceFeatures(device.cpuFeatures);
  const yesNo = (v: boolean | undefined) => (v === undefined ? "—" : v ? t("evaluation.preview.yes") : t("evaluation.preview.no"));

  const phone: [string, string][] = [
    [t("evaluation.preview.phone"), [device.brand, device.model].filter(Boolean).join(" ") || "—"],
    [t("evaluation.preview.chipset"), describeChipset(device) ?? "—"],
    [t("evaluation.preview.cpu"), [device.cpuCores ? t("evaluation.preview.cores", { count: device.cpuCores }) : null, describeCores(device.coreMaxFreqKHz)].filter(Boolean).join(" · ") || "—"],
    ["i8mm", yesNo(features?.i8mm)],
    ["dotprod", yesNo(features?.dotprod)],
    [t("evaluation.preview.ram"), gb(device.ramBytes)],
    [t("evaluation.preview.os"), device.osVersion ? `${device.platform === "ios" ? "iOS" : "Android"} ${device.osVersion}${device.apiLevel ? ` (API ${device.apiLevel})` : ""}` : "—"],
    [t("evaluation.preview.app"), appVersion],
  ];

  if (progress) {
    // Back does nothing while sending (the progress screen's own buttons end it).
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={sending ? () => {} : onCancel}>
        {progress}
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {/* A Modal is a new window: it doesn't inherit the app's safe area, so it sets its own. */}
      <SafeAreaView style={styles.container} edges={["top", "bottom", "left", "right"]}>
        <View style={styles.header}>
          <Text style={styles.title}>{t("evaluation.preview.title")}</Text>
          <Text style={styles.subtitle}>{t("evaluation.preview.subtitle")}</Text>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.section}>{t("evaluation.preview.phoneSection")}</Text>
          <View style={styles.card}>
            {phone.map(([label, value]) => (
              <View key={label} style={styles.kv}>
                <Text style={styles.k}>{label}</Text>
                <Text style={styles.v}>{value}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.section}>{t("evaluation.preview.modelsSection")}</Text>
          {scores.map((s) => (
            <View key={s.configId} style={styles.card}>
              <View style={styles.scoreRow}>
                <Text style={styles.model} numberOfLines={2}>{s.modelLabel ?? s.configId}</Text>
                <Text style={styles.score}>{s.score}</Text>
              </View>
              <Text style={styles.parts}>
                {t("evaluation.preview.parts", { speed: pct(s.speed), reliability: pct(s.reliability), retrieval: pct(s.retrieval) })}
              </Text>
              <View style={styles.metrics}>
                <Metric label={t("evaluation.preview.tokPerSec")} value={s.medianTokPerSec == null ? "—" : s.medianTokPerSec.toFixed(1)} />
                <Metric label={t("evaluation.preview.ttft")} value={secs(s.medianTtftMs)} />
                <Metric label={t("evaluation.preview.total")} value={secs(s.medianTotalMs)} />
                <Metric label={t("evaluation.preview.peakRam")} value={gb(s.peakRssBytes)} />
                <Metric label={t("evaluation.preview.completed")} value={`${s.completed}/${s.answers}`} />
                <Metric label={t("evaluation.preview.sources")} value={s.retrievalQuestions > 0 ? `${s.retrievalHits}/${s.retrievalQuestions}` : "—"} />
              </View>
            </View>
          ))}
          <Text style={styles.note}>
            {t("evaluation.preview.formula", {
              version: SCORE_VERSION,
              speed: WEIGHTS.speed * 100,
              reliability: WEIGHTS.reliability * 100,
              retrieval: WEIGHTS.retrieval * 100,
              reference: REFERENCE_TOK_PER_SEC,
            })}
          </Text>

          <Pressable style={styles.card} onPress={() => setShowAnswers((v) => !v)} accessibilityRole="button">
            <Text style={styles.k}>
              {showAnswers ? "▾ " : "▸ "}
              {t("evaluation.preview.answers", { count: rows.length })}
            </Text>
          </Pressable>
          {showAnswers &&
            rows.map((r) => (
              <View key={`${r.configId}:${r.queryId}`} style={styles.answer}>
                <Text style={styles.q}>{r.query}</Text>
                <Text style={styles.a}>{r.answer || "—"}</Text>
                <Text style={styles.meta}>{r.configLabel}</Text>
              </View>
            ))}

          <Text style={styles.section}>{t("evaluation.preview.notSentSection")}</Text>
          <Text style={styles.body}>{t("evaluation.preview.notSent")}</Text>
        </ScrollView>
        <View style={styles.actions}>
          <Pressable style={styles.btn} onPress={onCancel} disabled={sending} accessibilityRole="button">
            <Text style={styles.btnText}>{t("common.cancel")}</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.primary, sending && styles.disabled]} onPress={onShare} disabled={sending} accessibilityRole="button">
            {sending ? <ActivityIndicator color={colors.text.heading} /> : <Text style={[styles.btnText, styles.primaryText]}>{t("evaluation.shareConfirm")}</Text>}
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.surface },
  header: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
    backgroundColor: colors.bg.cardElevated,
    gap: 4,
  },
  title: { ...typography.ui.titleSm, color: colors.text.heading },
  subtitle: { ...typography.ui.subtext, color: colors.text.dim },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxxl },
  section: { ...typography.ui.subtext, color: colors.text.heading, fontWeight: "700", marginTop: spacing.sm },
  card: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.sm,
    gap: 6,
  },
  kv: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  k: { ...typography.ui.subtext, color: colors.text.dim },
  v: { ...typography.ui.subtext, color: colors.text.primary, flexShrink: 1, textAlign: "right" },
  scoreRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  model: { ...typography.ui.subtext, color: colors.text.primary, fontWeight: "700", flex: 1 },
  score: { ...typography.ui.titleSm, color: colors.text.accentEmerald, fontWeight: "700" },
  parts: { ...typography.mono.xs, color: colors.text.dim },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  metric: { minWidth: "28%", flexGrow: 1 },
  metricValue: { ...typography.mono.xs, color: colors.text.accentCyan, fontWeight: "600" },
  metricLabel: { ...typography.mono.xs, fontSize: 10, color: colors.text.dim },
  note: { ...typography.mono.xs, fontSize: 10, color: colors.text.dim },
  answer: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderLeftWidth: 2, borderLeftColor: colors.border.default, gap: 2 },
  q: { ...typography.ui.subtext, color: colors.text.primary, fontWeight: "600" },
  a: { ...typography.ui.subtext, color: colors.text.primary },
  meta: { ...typography.mono.xs, fontSize: 10, color: colors.text.dim },
  body: { ...typography.ui.subtext, color: colors.text.primary },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
    backgroundColor: colors.bg.cardElevated,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.default,
    alignItems: "center",
  },
  btnText: { ...typography.ui.subtext, color: colors.text.accentCyan, fontWeight: "600" },
  primary: { backgroundColor: colors.text.accentEmerald, borderColor: colors.text.accentEmerald },
  primaryText: { color: colors.bg.surface },
  disabled: { opacity: 0.5 },
});
