import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from "react-native";
import { Text } from "./components/AppText";
import { useTranslation } from "react-i18next";
import { impact, ImpactFeedbackStyle } from "../services/haptics";
import { llamaEngine } from "../inference/LlamaEngine";
import { getRoutingPreset } from "../models/settings";
import type { CatalogModel } from "../models/manifest";
import { EVAL_SET, EVAL_SET_VERSION } from "../eval/evalSet";
import { EvalConfig, evalConfigId, EvalResultRow } from "../eval/evalHarness.pure";
import { exportEvalResults, listInstalledEvalModels, runEvaluation, EvalProgress, EvaluationRun } from "../eval/evalHarness";
import { runDeviceEvalRequest } from "../eval/deviceEvalRequest";
import type { EvalRequest } from "../eval/deviceEvalRequest.pure";
import { resultsSharingAvailable, shareDevice, shareEvalRun } from "../eval/shareResults";
import {
  SHARE_MIN_MS,
  shareSucceeded,
  STEP_MIN_MS,
  type ShareDevice,
  type ShareOutcome,
  type ShareStep,
  type ShareStepInfo,
} from "../eval/shareResults.pure";
import { SharePreview } from "./SharePreview";
import { ShareProgress, type ShareLogLine } from "./ShareProgress";
import appConfig from "../../app.json";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

interface Props {
  onClose?: () => void;
  /** A chat reply is still generating — running an evaluation now would fight it for the model. */
  chatBusy?: boolean;
  /** Sent from a development machine (scripts/eval-device.mjs): runs immediately with its own selection. */
  deviceRequest?: EvalRequest;
}

function formatMs(ms: number | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function outcomeColor(outcome: EvalResultRow["outcome"]): string {
  if (outcome === "failure") return colors.crimson[400];
  if (outcome === "cancelled") return colors.amber[400];
  return colors.text.accentEmerald;
}

/**
 * Runs the fixed evaluation set (src/eval/evalSet.ts) against selected
 * configurations and exports the structured results. See
 * docs/EVAL_QUERIES.md for the workflow.
 */
export function EvaluationScreen({ onClose, chatBusy, deviceRequest }: Props) {
  const { t, i18n } = useTranslation();
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [preset, setPreset] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<EvalProgress | null>(null);
  const [rows, setRows] = useState<EvalResultRow[]>([]);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const [previewDevice, setPreviewDevice] = useState<ShareDevice | null>(null);
  const stopRef = useRef(false);

  useEffect(() => {
    (async () => {
      const [installed, p] = await Promise.all([listInstalledEvalModels(), getRoutingPreset()]);
      setModels(installed);
      setPreset(p);
      setSelected(new Set([...installed.map((m) => `model:${m.id}`), "adaptive"]));
    })();
  }, []);

  const configs: EvalConfig[] = [
    ...(models ?? []).map((m): EvalConfig => ({ kind: "model", modelId: m.id, label: m.label })),
    { kind: "adaptive", label: t("evaluation.adaptiveConfig", { preset }) },
  ];
  const chosen = configs.filter((c) => selected.has(evalConfigId(c)));

  const toggle = (id: string) => {
    if (running) return;
    impact(ImpactFeedbackStyle.Light);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRun = async () => {
    impact(ImpactFeedbackStyle.Medium);
    stopRef.current = false;
    setRunning(true);
    setStopping(false);
    setRows([]);
    setRun(null);
    const callbacks = {
      onProgress: setProgress,
      onRow: (row: EvalResultRow) => setRows((prev) => [...prev, row]),
      shouldStop: () => stopRef.current,
    };
    try {
      const result = deviceRequest
        ? await runDeviceEvalRequest(deviceRequest, (p) => t("evaluation.adaptiveConfig", { preset: p }), callbacks)
        : await runEvaluation({ configs: chosen, ...callbacks });
      setRun(result);
    } catch (e: any) {
      Alert.alert(t("evaluation.runFailedTitle"), e?.message ?? String(e));
    } finally {
      setRunning(false);
      setStopping(false);
      setProgress(null);
    }
  };

  const handleStop = async () => {
    impact(ImpactFeedbackStyle.Medium);
    stopRef.current = true;
    setStopping(true);
    await llamaEngine.stop();
  };

  const handleExport = async (format: "jsonl" | "csv") => {
    if (!run) return;
    impact(ImpactFeedbackStyle.Light);
    try {
      await exportEvalResults(run, format);
    } catch (e: any) {
      Alert.alert(t("evaluation.exportFailedTitle"), e?.message ?? String(e));
    }
  };

  // Nothing leaves the phone until the user has seen everything that will be sent (SharePreview)
  // and pressed Share there.
  const handleShare = () => {
    if (!run || run.rows.length === 0) return;
    impact(ImpactFeedbackStyle.Light);
    setPreviewDevice(shareDevice());
  };

  // A second tap before the button re-renders disabled must not send the run again.
  const sendingRef = useRef(false);
  const [shareUi, setShareUi] = useState<{ step: ShareStep | null; log: ShareLogLine[]; outcome: ShareOutcome | null } | null>(null);
  const logLine = (step: ShareStep, info?: ShareStepInfo): string => {
    if (step === "challenge" && info?.challenge) return t("evaluation.shareProgress.log.challengeGot", { code: info.challenge });
    if (step === "key" && info?.key) return t(`evaluation.shareProgress.log.key-${info.key}`);
    if (step === "send") return t("evaluation.shareProgress.log.send", { size: `${Math.max(1, Math.round((info?.bytes ?? 0) / 1024))} KB`, count: info?.rows ?? 0 });
    return t(`evaluation.shareProgress.log.${step}`, { count: info?.rows ?? 0 });
  };
  // The progress screen replaces the preview: each step as it runs, then the outcome.
  const confirmShare = async () => {
    if (!run || sendingRef.current) return;
    sendingRef.current = true;
    setSharing(true);
    impact(ImpactFeedbackStyle.Light);
    const started = Date.now();
    setShareUi({ step: "prepare", log: [], outcome: null });
    // Steps reach the screen one at a time, each for at least STEP_MIN_MS.
    let shown = Promise.resolve();
    const onStep = (step: ShareStep, info?: ShareStepInfo) => {
      shown = shown.then(async () => {
        setShareUi((s) => s && { ...s, step, log: [...s.log, { key: `${s.log.length}`, text: logLine(step, info) }] });
        await new Promise((r) => setTimeout(r, STEP_MIN_MS));
      });
    };
    let outcome: ShareOutcome = { result: "failed" };
    try {
      outcome = await shareEvalRun(run.rows, onStep);
    } catch (e) {
      outcome = { result: "failed", detail: String((e as Error)?.message ?? e) };
    }
    await shown;
    const wait = SHARE_MIN_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    sendingRef.current = false;
    setSharing(false);
    if (shareSucceeded(outcome.result)) setShared(run.runId);
    const status = outcome.status ? t("evaluation.shareProgress.log.status", { status: outcome.status }) : null;
    setShareUi((s) => s && { step: null, outcome, log: status ? [...s.log, { key: `${s.log.length}`, text: status }] : s.log });
    impact(shareSucceeded(outcome.result) ? ImpactFeedbackStyle.Medium : ImpactFeedbackStyle.Light);
  };
  const closeShare = () => {
    setShareUi(null);
    setPreviewDevice(null);
  };
  // "You can share again at 14:05" (or "Tue 09:30" when that is another day).
  const retryAtText = (() => {
    const at = shareUi?.outcome?.retryAt ? new Date(shareUi.outcome.retryAt) : null;
    return at
      ? at.toLocaleString(i18n.language, {
          ...(at.toDateString() === new Date().toDateString() ? {} : { weekday: "short" }),
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;
  })();

  const canRun = !running && !chatBusy && chosen.length > 0 && models !== null;

  const autoStarted = useRef(false);
  useEffect(() => {
    if (deviceRequest && models !== null && !autoStarted.current) {
      autoStarted.current = true;
      handleRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceRequest, models]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View>
            <Text style={styles.headerTitle}>{t("evaluation.title")}</Text>
            <Text style={styles.headerSubtitle}>
              {t("evaluation.subtitle", { version: EVAL_SET_VERSION, count: EVAL_SET.length })}
            </Text>
          </View>
        </View>
        {!running && (
          <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>{t("common.done")}</Text>
          </Pressable>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {deviceRequest && (
          <Text style={styles.note}>{t("evaluation.deviceRequest", { id: deviceRequest.requestId })}</Text>
        )}
        <Text style={styles.sectionTitle}>{t("evaluation.configsTitle")}</Text>
        {deviceRequest ? null : models === null ? (
          <ActivityIndicator color={colors.emerald[400]} />
        ) : (
          <>
            {models.length === 0 && <Text style={styles.note}>{t("evaluation.noModels")}</Text>}
            {configs.map((c) => {
              const id = evalConfigId(c);
              const on = selected.has(id);
              return (
                <Pressable key={id} style={styles.configRow} onPress={() => toggle(id)}>
                  <Text style={[styles.checkbox, on && styles.checkboxOn]}>{on ? "☑" : "☐"}</Text>
                  <Text style={styles.configLabel} numberOfLines={1}>
                    {c.label}
                  </Text>
                </Pressable>
              );
            })}
          </>
        )}

        {!deviceRequest && (
          <Text style={styles.note}>
            {t("evaluation.summary", { queries: EVAL_SET.length, configs: chosen.length, total: EVAL_SET.length * chosen.length })}
          </Text>
        )}
        <Text style={styles.note}>{chatBusy ? t("evaluation.chatBusy") : t("evaluation.keepScreenOn")}</Text>

        <View style={styles.actionsRow}>
          {running ? (
            <Pressable style={[styles.actionBtn, styles.stopBtn]} onPress={handleStop} disabled={stopping}>
              <Text style={[styles.actionBtnText, styles.stopBtnText]}>
                {stopping ? t("evaluation.stopping") : t("evaluation.stop")}
              </Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.actionBtn, !canRun && styles.disabled]} onPress={handleRun} disabled={!canRun}>
              <Text style={styles.actionBtnText}>{t("evaluation.run")}</Text>
            </Pressable>
          )}
          {run && !running && (
            <>
              <Pressable style={styles.actionBtn} onPress={() => handleExport("jsonl")}>
                <Text style={styles.actionBtnText}>{t("evaluation.exportJsonl")}</Text>
              </Pressable>
              <Pressable style={styles.actionBtn} onPress={() => handleExport("csv")}>
                <Text style={styles.actionBtnText}>{t("evaluation.exportCsv")}</Text>
              </Pressable>
              {resultsSharingAvailable && (
                <Pressable
                  style={[styles.actionBtn, (sharing || shared === run.runId) && styles.disabled]}
                  onPress={handleShare}
                  disabled={sharing || shared === run.runId}
                >
                  <Text style={styles.actionBtnText}>
                    {sharing ? t("evaluation.sharing") : shared === run.runId ? t("evaluation.shared") : t("evaluation.share")}
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </View>

        {progress && (
          <View style={styles.progressBox}>
            <Text style={styles.progressText}>
              {t("evaluation.progress", {
                config: progress.configIndex + 1,
                configs: progress.configCount,
                query: progress.queryIndex + 1,
                queries: progress.queryCount,
              })}
            </Text>
            <Text style={styles.progressQuery} numberOfLines={2}>
              {progress.config.label} — {progress.query.query}
            </Text>
          </View>
        )}

        {run && (
          <Text style={styles.note} selectable>
            {run.stopped ? `${t("evaluation.stoppedEarly")} ` : ""}
            {t("evaluation.savedTo", { path: run.savedPath })}
          </Text>
        )}

        {rows.map((r) => {
          const key = `${r.configId}/${r.queryId}`;
          const open = expanded === key;
          return (
            <Pressable key={key} style={styles.row} onPress={() => setExpanded(open ? null : key)}>
              <View style={styles.rowHeader}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {r.queryId} · {r.configLabel}
                </Text>
                <Text style={[styles.outcome, { color: outcomeColor(r.outcome) }]}>{(r.outcome ?? "—").toUpperCase()}</Text>
              </View>
              <Text style={styles.meta}>
                {r.modelId ?? "—"} · {r.taskType ?? "—"} · {r.modelResidency ?? "—"} ·{" "}
                {r.retrievalUsed ? r.retrievedTitles.slice(0, 2).join(", ") : t("evaluation.noRetrieval")}
              </Text>
              <Text style={styles.meta}>
                {r.tokPerSec ? `${r.tokPerSec.toFixed(1)} t/s` : "—"} · load {formatMs(r.modelLoadMs)} · TTFT {formatMs(r.ttftMs)} · total{" "}
                {formatMs(r.totalLatencyMs)}
              </Text>
              <Text style={styles.answer} numberOfLines={open ? undefined : 3}>
                {r.errorMessage && r.outcome === "failure" ? r.errorMessage : r.answer}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {run && previewDevice && (
        <SharePreview
          visible
          rows={run.rows}
          device={previewDevice}
          appVersion={appConfig.expo.version}
          sending={sharing}
          onCancel={closeShare}
          onShare={confirmShare}
          progress={
            shareUi ? (
              <ShareProgress
                step={shareUi.step}
                log={shareUi.log}
                outcome={shareUi.outcome}
                retryAtText={retryAtText}
                onDone={closeShare}
                onRetry={confirmShare}
                onExport={handleExport}
              />
            ) : null
          }
        />
      )}
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
  headerTitle: { ...typography.ui.titleSm, color: colors.text.heading, letterSpacing: 0.5 },
  headerSubtitle: { ...typography.mono.xs, fontSize: 9, color: colors.text.dim },
  closeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.xs,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  closeBtnText: { ...typography.mono.xs, color: colors.text.accentCyan, fontWeight: "600" },
  scrollContent: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxxl },
  sectionTitle: { ...typography.ui.subtext, color: colors.text.heading, fontWeight: "700" },
  configRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.bg.cardElevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  checkbox: { fontSize: 16, color: colors.text.dim },
  checkboxOn: { color: colors.text.accentEmerald },
  configLabel: { ...typography.ui.subtext, color: colors.text.primary, flex: 1 },
  note: { ...typography.mono.xs, fontSize: 10, color: colors.text.dim },
  actionsRow: { flexDirection: "row", gap: spacing.sm },
  actionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.bg.cardElevated,
    borderWidth: 1,
    borderColor: colors.border.default,
    alignItems: "center",
  },
  actionBtnText: { ...typography.mono.xs, color: colors.text.accentCyan, fontWeight: "600" },
  stopBtn: { borderColor: colors.crimson.border, backgroundColor: colors.crimson.bgSubtle },
  stopBtnText: { color: colors.crimson[400] },
  disabled: { opacity: 0.4 },
  progressBox: {
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.default,
    backgroundColor: colors.bg.cardElevated,
    gap: 4,
  },
  progressText: { ...typography.mono.xs, color: colors.text.accentCyan, fontWeight: "600" },
  progressQuery: { ...typography.ui.subtext, color: colors.text.primary },
  row: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.sm,
    gap: 4,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  rowTitle: { ...typography.ui.subtext, color: colors.text.heading, fontWeight: "700", flex: 1 },
  outcome: { ...typography.mono.xs, fontSize: 9, fontWeight: "600" },
  meta: { ...typography.mono.xs, fontSize: 9, color: colors.text.dim },
  answer: { ...typography.ui.subtext, color: colors.text.primary },
});
