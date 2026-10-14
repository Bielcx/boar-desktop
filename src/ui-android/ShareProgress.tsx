/**
 * The share after the user confirmed it: each step as it runs (a progress bar and a short log of
 * what the phone and the server did), then the outcome, why, and what to do. The run can always
 * be exported as JSONL or CSV from here, whatever happened. Shown in place of SharePreview.
 */
import React from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { SHARE_STEPS, shareCanRetry, shareSucceeded, type ShareOutcome, type ShareStep } from "../eval/shareResults.pure";
import { Text } from "./components/AppText";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

export interface ShareLogLine {
  key: string;
  text: string;
}

interface Props {
  /** The step on screen while sending; null once the outcome is shown. */
  step: ShareStep | null;
  log: ShareLogLine[];
  outcome: ShareOutcome | null;
  /** "14:05" or "Tue 09:30", when the server said when sharing opens again. */
  retryAtText: string | null;
  onDone: () => void;
  onRetry: () => void;
  onExport: (format: "jsonl" | "csv") => void;
}

export function ShareProgress({ step, log, outcome, retryAtText, onDone, onRetry, onExport }: Props) {
  const { t } = useTranslation();
  const sending = outcome === null;
  const index = step ? SHARE_STEPS.indexOf(step) : SHARE_STEPS.length;
  const value = sending ? (index + 0.5) / SHARE_STEPS.length : 1;
  const ok = outcome ? shareSucceeded(outcome.result) : false;
  const result = outcome?.result;
  const when = retryAtText && (result === "rate-limited" || result === "cooldown") ? "At" : "";
  const barColor = !sending && !ok ? colors.crimson[500] : colors.emerald[500];

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom", "left", "right"]}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>
            {sending ? t("evaluation.shareProgress.sendingTitle") : t(`evaluation.shareProgress.title.${result}`)}
          </Text>
          {sending && step ? <Text style={styles.stepText}>{t(`evaluation.shareProgress.step.${step}`)}</Text> : null}
        </View>

        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel={t("evaluation.shareProgress.sendingTitle")}
          accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
        >
          <View style={[styles.fill, { width: `${value * 100}%`, backgroundColor: barColor }]} />
        </View>

        {!sending && result ? (
          <Text style={[styles.why, ok && styles.whyOk]}>{t(`evaluation.shareProgress.why.${result}${when}`, { time: retryAtText })}</Text>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("evaluation.shareProgress.logTitle")}</Text>
          <View accessible accessibilityLabel={log.map((l) => l.text).join(". ")} style={styles.logLines}>
            {log.map((l) => (
              <Text key={l.key} style={styles.logLine}>
                {l.text}
              </Text>
            ))}
            {outcome?.detail ? (
              <Text style={[styles.logLine, !ok && styles.logError]}>{t("evaluation.shareProgress.detail", { detail: outcome.detail })}</Text>
            ) : null}
          </View>
        </View>

        {!sending ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t("evaluation.shareProgress.exportTitle")}</Text>
            <View style={styles.row}>
              <Pressable style={styles.smallBtn} onPress={() => onExport("jsonl")}>
                <Text style={styles.smallBtnText}>{t("evaluation.exportJsonl")}</Text>
              </Pressable>
              <Pressable style={styles.smallBtn} onPress={() => onExport("csv")}>
                <Text style={styles.smallBtnText}>{t("evaluation.exportCsv")}</Text>
              </Pressable>
            </View>
            <Text style={styles.footer}>{t("evaluation.shareProgress.exportFooter")}</Text>
          </View>
        ) : null}
      </ScrollView>

      {!sending ? (
        <View style={[styles.row, styles.actions]}>
          {result && shareCanRetry(result) ? (
            <Pressable style={[styles.btn, styles.btnSecondary]} onPress={onRetry}>
              <Text style={styles.btnSecondaryText}>{t("evaluation.shareProgress.retry")}</Text>
            </Pressable>
          ) : null}
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onDone}>
            <Text style={styles.btnPrimaryText}>{t("common.done")}</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.terminal },
  body: { padding: spacing.base, gap: spacing.lg },
  titleBlock: { gap: spacing.xs },
  title: { ...typography.ui.headline, color: colors.text.heading },
  stepText: { ...typography.ui.bodyLg, color: colors.text.secondary },
  track: { height: 8, borderRadius: radii.full, backgroundColor: colors.bg.cardHover, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radii.full },
  why: { ...typography.ui.body, color: colors.text.primary },
  whyOk: { color: colors.text.heading },
  card: { backgroundColor: colors.bg.card, borderRadius: 18, padding: spacing.md, gap: spacing.sm },
  cardTitle: { ...typography.ui.caption, fontWeight: "600", color: colors.text.secondary },
  logLines: { gap: 2 },
  logLine: { ...typography.mono.sm, color: colors.text.muted },
  logError: { color: colors.crimson[400] },
  row: { flexDirection: "row", gap: spacing.sm },
  smallBtn: { backgroundColor: colors.bg.cardHover, borderRadius: radii.full, paddingHorizontal: spacing.base, paddingVertical: spacing.sm },
  smallBtnText: { ...typography.ui.caption, fontWeight: "600", color: colors.text.primary },
  footer: { ...typography.ui.subtext, color: colors.text.dim },
  actions: { padding: spacing.base },
  btn: { flex: 1, minHeight: 48, borderRadius: radii.full, alignItems: "center", justifyContent: "center" },
  btnPrimary: { backgroundColor: colors.emerald[600] },
  btnPrimaryText: { ...typography.ui.body, fontWeight: "700", color: colors.text.heading },
  btnSecondary: { backgroundColor: colors.bg.cardHover },
  btnSecondaryText: { ...typography.ui.body, fontWeight: "600", color: colors.text.primary },
});
