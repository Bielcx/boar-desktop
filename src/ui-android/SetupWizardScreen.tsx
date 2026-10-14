import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  StyleSheet,
  Pressable,
  ScrollView,
  Image,
  ActivityIndicator,
  AppState,
} from "react-native";
import { Text } from "./components/AppText";
import { LinearGradient } from "expo-linear-gradient";
import { impact, notification, ImpactFeedbackStyle, NotificationFeedbackType } from "../services/haptics";
import { useTranslation } from "react-i18next";
import * as FileSystem from "expo-file-system/legacy";
import { getDeviceTotalRamBytes } from "ram-monitor";
import {
  TIERS,
  SetupTier,
  MODEL_CATALOG,
  CORPUS_CATALOG,
  CatalogModel,
  ANSWER_MODELS,
} from "../models/manifest";
import { getActiveModelId, setActiveModelId } from "../models/settings";
import { answerModelToInstall, heavyForPhone, recommendedAnswerModel } from "./setupModel";
import { ModelManager } from "../models/ModelManager";
import {
  startDownload,
  restartDownload,
  getDownloadState,
  isDownloading,
  subscribeDownloads,
} from "../services/downloadManager";
import { onSeedProgress, seedKnowledgeBaseIfEmpty, SeedProgress } from "../rag/seedCorpus";
import { embeddingEngine } from "../rag/embed";
import { useTheme, colors, typography } from "./theme";
import { ThemeSelector } from "./components/ThemeSelector";
import { LanguageSelector } from "./components/LanguageSelector";
import { spacing, radii } from "./theme/spacing";
import { AccordionSection } from "./AccordionSection";

const modelManager = new ModelManager();

interface Props {
  onReady: () => void;
  onSkip?: () => void;
}

type WizardStep = 1 | 2 | 3 | 4;

interface HardwareScan {
  totalRamBytes: number;
  freeStorageBytes: number;
  scanned: boolean;
}

function readTotalRam(): number {
  try {
    return getDeviceTotalRamBytes();
  } catch {
    return 0;
  }
}

function formatGB(bytes: number): string {
  if (bytes <= 0) return "0.0 GB";
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatSpeed(bytesPerSec: number | undefined, calculatingLabel: string): string {
  if (!bytesPerSec || bytesPerSec <= 0) return calculatingLabel;
  return bytesPerSec >= 1024 * 1024
    ? `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
    : `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}

function formatEta(seconds: number | undefined, estimatingLabel: string): string {
  if (seconds == null || seconds <= 0 || !isFinite(seconds)) return estimatingLabel;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

/** Seconds left at the pace since the screen started watching, or undefined while too early to tell. */
function seedEtaSeconds(p: SeedProgress, start: { at: number; done: number } | null): number | undefined {
  if (!start) return undefined;
  const elapsed = (Date.now() - start.at) / 1000;
  const indexed = p.done - start.done;
  if (elapsed < 3 || indexed < 5) return undefined;
  return ((p.total - p.done) * elapsed) / indexed;
}

export function SetupWizardScreen({ onReady, onSkip }: Props) {
  const { colors, typography } = useTheme();
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedTier, setSelectedTier] = useState<SetupTier>("standard");
  // The answer model the user tapped; until then, one already on the phone or the recommended one.
  const [chosenModelId, setChosenModelId] = useState<string | undefined>();
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  // RAM is read synchronously here, so the recommended model is right from the first render.
  const [hardware, setHardware] = useState<HardwareScan>(() => ({
    totalRamBytes: readTotalRam(),
    freeStorageBytes: 0,
    scanned: false,
  }));
  const [indexingPhase, setIndexingPhase] = useState<"waiting" | "building" | "ready" | "error">("waiting");
  const [indexingError, setIndexingError] = useState<string | null>(null);
  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null);
  // Where the count was when this screen started watching, for a time-left estimate.
  const seedStart = useRef<{ at: number; done: number } | null>(null);

  useEffect(
    () =>
      onSeedProgress((p) => {
        seedStart.current ??= { at: Date.now(), done: p.done };
        setSeedProgress(p);
      }),
    []
  );
  const [, forceRender] = useState(0);

  // Subscribe to live download progress
  useEffect(() => subscribeDownloads(() => forceRender((n) => n + 1)), []);

  // Hardware Diagnostics Scan
  useEffect(() => {
    (async () => {
      const ram = readTotalRam();
      let freeStorage = 0;
      try {
        freeStorage = await FileSystem.getFreeDiskStorageAsync();
      } catch {
        freeStorage = 0;
      }
      setHardware({
        totalRamBytes: ram,
        freeStorageBytes: freeStorage,
        scanned: true,
      });
    })();
  }, []);

  const refreshPresence = useCallback(async () => {
    const statuses = await modelManager.statusAll();
    const presMap = Object.fromEntries(statuses.map((s) => [s.asset.id, s.present]));
    setPresence(presMap);
    return presMap;
  }, []);

  useEffect(() => {
    refreshPresence();
  }, [refreshPresence]);

  // Reopened after the app was closed mid-download: keep the model chosen then, not today's pick.
  useEffect(() => {
    getActiveModelId("llm").then((id) => {
      if (id && ANSWER_MODELS.some((m) => m.id === id)) setChosenModelId((cur) => cur ?? id);
    });
  }, []);

  const activeTierConfig = TIERS.find((t) => t.id === selectedTier) ?? TIERS[0];
  const tierCorpusPackIds = activeTierConfig.corpusPackIds ?? [];
  // No chat model is `required` (one is chosen in step 2), so the downloads add the chosen one.
  const recommendedModel = recommendedAnswerModel(ANSWER_MODELS, hardware.totalRamBytes);
  const answerModelFor = (pres: Record<string, boolean>) =>
    answerModelToInstall(ANSWER_MODELS, pres, hardware.totalRamBytes, chosenModelId);
  const assetsFor = (pres: Record<string, boolean>): CatalogModel[] => {
    const answer = answerModelFor(pres);
    return [
      ...MODEL_CATALOG.filter((m) => m.required),
      ...(answer ? [answer] : []),
      ...CORPUS_CATALOG.filter((c) => tierCorpusPackIds.includes(c.id)),
    ];
  };
  const answerModel = answerModelFor(presence);
  const tierAssets = assetsFor(presence);

  const allAssetsPresent = tierAssets.every((m) => presence[m.id]);

  const handleStartDownloads = useCallback(async () => {
    impact(ImpactFeedbackStyle.Medium);
    setStep(3);
    const presMap = await refreshPresence();
    const answer = answerModelFor(presMap);
    if (answer) {
      // Fixed from here on: the RAM scan or a later presence check must not switch the model mid-download.
      setChosenModelId(answer.id);
      await setActiveModelId("llm", answer.id);
    }

    for (const asset of assetsFor(presMap)) {
      if (!presMap[asset.id]) {
        // presence (and therefore allAssetsPresent / each PhaseRow's status)
        // is only ever set from an explicit statusAll() scan, not derived
        // from download progress — without re-checking here, a finished
        // 100%-downloaded file never flips its PhaseRow from
        // PENDING/QUEUED to COMPLETE, and indexing never starts.
        startDownload(asset).finally(() => refreshPresence());
      }
    }
  }, [refreshPresence, assetsFor, answerModelFor]);

  // Downloads done: move on to indexing.
  useEffect(() => {
    if (step === 3 && allAssetsPresent) setStep(4);
  }, [step, allAssetsPresent]);

  // Step 4: seed the knowledge base on the phone. Indexing embeds every
  // article, so the embedding model has to be loaded first; only the chat
  // screen loaded it before.
  useEffect(() => {
    if (step === 4) {
      (async () => {
        try {
          setIndexingPhase("building");
          const emb = MODEL_CATALOG.find((m) => m.kind === "embedding" && m.required)!;
          await embeddingEngine.load(emb.filename);
          await seedKnowledgeBaseIfEmpty();
          setIndexingPhase("ready");
          notification(NotificationFeedbackType.Success);
        } catch (e: any) {
          setIndexingError(e?.message ?? String(e));
          setIndexingPhase("error");
        }
      })();
    }
  }, [step]);

  // Compute aggregate download metrics across tier assets
  let totalBytesExpected = 0;
  let totalBytesWritten = 0;
  let activeSpeed = 0;
  let maxEta = 0;
  let isAnyDownloading = false;
  let completedCount = 0;
  let currentAssetLabel: string | null = null;
  // Before this, a stalled/failed download just silently reverted to
  // "PENDING" with no way to know why or to retry — the mandatory first-run
  // wizard had no escape hatch at all (see docs/ADAPTIVE_ROUTING.md's
  // timeout/backgrounding findings; downloads had the exact same gap
  // generation timeouts did). failedAssets makes the error visible and
  // retriable instead.
  const failedAssets: { asset: CatalogModel; error: string }[] = [];

  for (const asset of tierAssets) {
    const dl = getDownloadState(asset.id);
    totalBytesExpected += asset.sizeBytes;
    if (presence[asset.id]) {
      totalBytesWritten += asset.sizeBytes;
      completedCount++;
    } else if (dl) {
      totalBytesWritten += dl.bytesWritten ?? 0;
      if (dl.downloading) {
        isAnyDownloading = true;
        // Assets download concurrently, but on a typical connection only
        // one actually makes visible progress at a time — surfacing which
        // one, plus a "2/3" count, is what stops a finished asset handing
        // off to the next one from reading as the whole thing restarting.
        if (!currentAssetLabel) currentAssetLabel = asset.label;
        if (dl.speedBytesPerSec) activeSpeed += dl.speedBytesPerSec;
        if (dl.etaSeconds && dl.etaSeconds > maxEta) maxEta = dl.etaSeconds;
      } else if (dl.error) {
        failedAssets.push({ asset, error: dl.error });
      }
    }
  }

  const retryFailedDownloads = useCallback(() => {
    impact(ImpactFeedbackStyle.Medium);
    for (const { asset } of failedAssets) {
      startDownload(asset).finally(() => refreshPresence());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedAssets, refreshPresence]);

  // Manual, unconditional escape hatch — distinct from retryFailedDownloads,
  // which only acts on assets that surfaced an explicit error. A download
  // can also go stuck with NO error at all (module-level download-tracking
  // state surviving a dev Fast Refresh mid-transfer while the actual native
  // task it pointed at is gone, or a real device silently dropping a
  // network task without a callback ever firing) — that state can't be
  // reliably auto-detected from here, so instead of guessing, this button
  // is just always available whenever setup isn't finished, and force-clears
  // + restarts every not-yet-present asset regardless of what the UI
  // currently believes its state is.
  const restartAllDownloads = useCallback(() => {
    impact(ImpactFeedbackStyle.Medium);
    for (const asset of tierAssets) {
      if (!presence[asset.id]) {
        restartDownload(asset).finally(() => refreshPresence());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierAssets, presence, refreshPresence]);

  // Auto-resume when the user returns to the app after backgrounding it —
  // expo-file-system pauses (not fails) a download while backgrounded, and
  // ModelManager.downloadCatalogModel's inactivity timeout also pauses
  // rather than cancels, so a "failed" download at this point is really
  // just parked, waiting for the same resumable to be resumed. Without
  // this, the only way to keep the mandatory setup screen moving forward
  // after swapping apps was to notice the error card and tap Retry
  // manually.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && failedAssets.length > 0) {
        retryFailedDownloads();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedAssets, retryFailedDownloads]);

  const aggregateProgress =
    totalBytesExpected > 0 ? Math.min(totalBytesWritten / totalBytesExpected, 1) : 0;

  return (
    <LinearGradient colors={[colors.bg.terminal, "#0A0F1D"]} style={styles.container}>
      {/* Wizard Progress Steps Bar */}
      <View style={styles.wizardProgressBar}>
        <View style={styles.stepsRow}>
          <StepBadge num={1} label={t("setupWizard.steps.hardware")} active={step === 1} completed={step > 1} />
          <View style={[styles.stepLine, step > 1 && styles.stepLineCompleted]} />
          <StepBadge num={2} label={t("setupWizard.steps.modelTier")} active={step === 2} completed={step > 2} />
          <View style={[styles.stepLine, step > 2 && styles.stepLineCompleted]} />
          <StepBadge num={3} label={t("setupWizard.steps.install")} active={step === 3} completed={step > 3} />
          <View style={[styles.stepLine, step > 3 && styles.stepLineCompleted]} />
          <StepBadge num={4} label={t("setupWizard.steps.indexing")} active={step === 4} completed={indexingPhase === "ready"} />
        </View>
      </View>

      {/* STEP 1: WELCOME & HARDWARE CHECK */}
      {step === 1 && (
        <ScrollView contentContainerStyle={styles.stepContent}>
          <View style={styles.mascotBanner}>
            <Image source={require("../../assets/boar.png")} style={styles.mascotHero} />
            <Text style={styles.heroTitle}>BOAR</Text>
            <Text style={styles.heroSubtitle}>{t("aboutScreen.heroSubtitle")}</Text>
          </View>

          <View style={styles.card}>
            <LanguageSelector compact />
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardIcon}>🛡️</Text>
              <Text style={styles.cardTitle}>{t("setupWizard.step1.terminalTitle")}</Text>
            </View>
            <Text style={styles.cardText}>{t("setupWizard.step1.terminalText")}</Text>
          </View>

          {/* Hardware Diagnostic Results */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardIcon}>🔍</Text>
              <Text style={styles.cardTitle}>{t("setupWizard.step1.hardwareTitle")}</Text>
            </View>

            <View style={styles.hardwareSpecs}>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>{t("setupWizard.step1.deviceRam")}</Text>
                <Text style={styles.specValue}>
                  {hardware.totalRamBytes > 0 ? formatGB(hardware.totalRamBytes) : t("setupWizard.step1.verified")}
                </Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>{t("setupWizard.step1.availableStorage")}</Text>
                <Text style={styles.specValue}>
                  {hardware.freeStorageBytes > 0
                    ? formatGB(hardware.freeStorageBytes)
                    : t("setupWizard.step1.sufficient")}
                </Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>{t("setupWizard.step1.ramBudget")}</Text>
                <Text style={[styles.specValue, { color: colors.text.accentEmerald }]}>
                  {t("setupWizard.step1.under12gb")}
                </Text>
              </View>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>{t("setupWizard.step1.inferenceEngine")}</Text>
                <Text style={styles.specValue}>{t("setupWizard.step1.inferenceEngineValue")}</Text>
              </View>
            </View>

            <View style={styles.verifiedBadge}>
              <View style={styles.verifiedDot} />
              <Text style={styles.verifiedText}>{t("setupWizard.step1.verifiedBadge")}</Text>
            </View>
          </View>

          <View style={styles.actionsBottom}>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => {
                impact(ImpactFeedbackStyle.Light);
                setStep(2);
              }}
            >
              <Text style={styles.primaryBtnText}>{t("setupWizard.step1.selectTierButton")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}

      {/* STEP 2: MODEL SELECTION */}
      {step === 2 && (
        <ScrollView contentContainerStyle={styles.stepContent}>
          <View style={styles.stepHeader}>
            <Text style={styles.stepTitle}>{t("setupWizard.step2.title")}</Text>
            <Text style={styles.stepSubtitle}>{t("setupWizard.step2.subtitle")}</Text>
          </View>

          {ANSWER_MODELS.map((model) => {
            const isSelected = answerModel?.id === model.id;
            const heavy = heavyForPhone(model, hardware.totalRamBytes);
            return (
              <Pressable
                key={model.id}
                style={[styles.tierCard, isSelected && styles.tierCardActive]}
                onPress={() => {
                  impact(ImpactFeedbackStyle.Light);
                  setChosenModelId(model.id);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
              >
                <View style={styles.tierHeader}>
                  <View style={styles.tierTitleRow}>
                    <Text style={styles.tierName}>{model.displayName ?? model.label}</Text>
                    {model.id === recommendedModel?.id && (
                      <View style={styles.recommendedPill}>
                        <Text style={styles.recommendedText}>{t("setupWizard.step2.recommended")}</Text>
                      </View>
                    )}
                  </View>
                  <View style={[styles.radioCircle, isSelected && styles.radioCircleActive]}>
                    {isSelected && <View style={styles.radioDot} />}
                  </View>
                </View>
                <Text style={styles.tierDesc}>{t(`setupWizard.step2.models.${model.answerTier}`)}</Text>
                <View style={styles.tierMetaRow}>
                  {presence[model.id] ? (
                    <View style={styles.compatPillGreen}>
                      <Text style={styles.compatPillGreenText}>{t("setupWizard.step2.onPhone")}</Text>
                    </View>
                  ) : heavy ? (
                    <View style={styles.heavyPill}>
                      <Text style={styles.heavyPillText}>{t("setupWizard.step2.heavy")}</Text>
                    </View>
                  ) : (
                    <View />
                  )}
                  <Text style={styles.tierFootprint}>{formatGB(model.sizeBytes)}</Text>
                </View>
                {heavy && isSelected && <Text style={styles.tierDesc}>{t("setupWizard.step2.heavyNote")}</Text>}
              </Pressable>
            );
          })}

          <View style={styles.stepHeader}>
            <Text style={styles.stepTitle}>{t("setupWizard.step2.knowledgeTitle")}</Text>
            <Text style={styles.stepSubtitle}>{t("setupWizard.step2.knowledgeSubtitle")}</Text>
          </View>

          {TIERS.map((tier) => {
            const isSelected = selectedTier === tier.id;
            return (
              <Pressable
                key={tier.id}
                style={[styles.tierCard, isSelected && styles.tierCardActive]}
                onPress={() => {
                  impact(ImpactFeedbackStyle.Light);
                  setSelectedTier(tier.id);
                }}
              >
                <View style={styles.tierHeader}>
                  <View style={styles.tierTitleRow}>
                    <Text style={styles.tierName}>{tier.label}</Text>
                    {tier.id === "standard" && (
                      <View style={styles.recommendedPill}>
                        <Text style={styles.recommendedText}>{t("setupWizard.step2.recommended")}</Text>
                      </View>
                    )}
                  </View>
                  <View
                    style={[
                      styles.radioCircle,
                      isSelected && styles.radioCircleActive,
                    ]}
                  >
                    {isSelected && <View style={styles.radioDot} />}
                  </View>
                </View>

                <Text style={styles.tierDesc}>{tier.description}</Text>
              </Pressable>
            );
          })}

          <View style={styles.actionsBottom}>
            <Pressable style={styles.primaryBtn} onPress={handleStartDownloads}>
              <Text style={styles.primaryBtnText}>{t("setupWizard.step2.installButton")}</Text>
            </Pressable>
            <Pressable
              style={styles.textBtn}
              onPress={() => setStep(1)}
              hitSlop={8}
            >
              <Text style={styles.textBtnText}>{t("setupWizard.step2.backButton")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}

      {/* STEP 3: INSTALL (downloads, the only network use) */}
      {step === 3 && (
        <ScrollView contentContainerStyle={styles.stepContent}>
          <View style={styles.stepHeader}>
            <Text style={styles.stepTitle}>{t("setupWizard.step3.title")}</Text>
            <Text style={styles.stepSubtitle}>{t("setupWizard.step3.subtitle")}</Text>
          </View>

          {/* Aggregate Download Progress Card */}
          <View style={styles.progressCard}>
            <View style={styles.progressHeader}>
              <View style={styles.progressLeft}>
                {isAnyDownloading && <ActivityIndicator size="small" color={colors.emerald[400]} />}
                <Text style={styles.progressTitle}>
                  {allAssetsPresent ? t("setupWizard.step3.assetsCached") : t("setupWizard.step3.downloadingWeights")}
                </Text>
              </View>
              <Text style={styles.progressPctText}>
                {(aggregateProgress * 100).toFixed(0)}%
              </Text>
            </View>

            {!allAssetsPresent && tierAssets.length > 1 && (
              <Text style={styles.progressAssetLabel}>
                {t("setupWizard.step3.assetCounter", {
                  current: Math.min(completedCount + 1, tierAssets.length),
                  total: tierAssets.length,
                  label: currentAssetLabel ?? "",
                })}
              </Text>
            )}

            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.max(aggregateProgress * 100, 3)}%` },
                ]}
              />
            </View>

            <View style={styles.telemetryMetricsRow}>
              <Text style={styles.telemetryBytes}>
                {formatGB(totalBytesWritten)} / {formatGB(totalBytesExpected)}
              </Text>
              {isAnyDownloading && (
                <View style={styles.telemetryRight}>
                  <Text style={styles.telemetrySpeed}>
                    {formatSpeed(activeSpeed, t("setupWizard.calculating"))}
                  </Text>
                  <Text style={styles.telemetryDot}>•</Text>
                  <Text style={styles.telemetryEta}>
                    {t("setupWizard.step3.eta", { eta: formatEta(maxEta, t("setupWizard.estimating")) })}
                  </Text>
                </View>
              )}
            </View>
          </View>

          {!allAssetsPresent && (
            <Pressable style={styles.restartAllBtn} onPress={restartAllDownloads}>
              <Text style={styles.restartAllBtnText}>{t("setupWizard.step3.restartDownloads")}</Text>
            </Pressable>
          )}

          {isAnyDownloading && (
            <View style={styles.tipBox}>
              <Text style={styles.tipLabel}>{t("setupWizard.step3.keepOpenLabel")}</Text>
              <Text style={styles.tipText}>{t("setupWizard.step3.keepOpenText")}</Text>
            </View>
          )}

          {/* Pipeline Phases */}
          <View style={styles.phasesCard}>
            <PhaseRow
              index="1"
              title={t("setupWizard.step3.phaseModel")}
              status={
                answerModel && presence[answerModel.id]
                  ? "COMPLETE"
                  : isAnyDownloading
                  ? "STREAMING"
                  : "PENDING"
              }
              t={t}
            />
            <PhaseRow
              index="2"
              title={t("setupWizard.step3.phaseEmbedding")}
              status={
                presence[MODEL_CATALOG.find((m) => m.kind === "embedding" && m.required)?.id ?? ""]
                  ? "COMPLETE"
                  : "PENDING"
              }
              t={t}
            />
          </View>

          {/* Off-Grid Terminal Tips */}
          <View style={styles.tipBox}>
            <Text style={styles.tipLabel}>{t("setupWizard.step3.tipLabel")}</Text>
            <Text style={styles.tipText}>{t("setupWizard.step3.tipText")}</Text>
          </View>

          {/* Download failure — without this, a stalled/failed download had
              no visible error and no retry option anywhere in this mandatory
              screen; the user was simply stuck. Placed above Interface
              Customization (rather than at the very bottom, past a
              collapsed accordion) so it's impossible to miss. */}
          {failedAssets.length > 0 && (
            <View style={styles.errorBox}>
              <Text style={styles.errorLabel}>{t("setupWizard.step3.downloadFailedLabel")}</Text>
              {failedAssets.map(({ asset, error }) => (
                <Text key={asset.id} style={styles.errorText}>
                  {asset.label}: {error}
                </Text>
              ))}
              <Pressable style={styles.retryBtn} onPress={retryFailedDownloads}>
                <Text style={styles.retryBtnText}>{t("setupWizard.step3.retryDownloads")}</Text>
              </Pressable>
            </View>
          )}

          {/* Interactive Theme & Font Legibility Customization — collapsible,
              same AccordionSection as Settings, last section on this page
              since it's cosmetic/optional, not part of getting set up. */}
          <View style={styles.tipBox}>
            <Text style={styles.customizeWhileWaitingText}>
              {t("setupWizard.step3.customizeWhileWaiting")}
            </Text>
            <AccordionSection title={t("setupWizard.step3.interfaceCustomization")}>
              <ThemeSelector />
            </AccordionSection>
          </View>

          <View style={styles.actionsBottom}>
            <View style={styles.waitingContainer}>
              <ActivityIndicator color={colors.emerald[400]} />
              <Text style={styles.waitingText}>{t("setupWizard.step3.waitingForDownloads")}</Text>
            </View>
          </View>
        </ScrollView>
      )}

      {/* STEP 4: INDEXING (on the phone, offline) */}
      {step === 4 && (
        <ScrollView contentContainerStyle={styles.stepContent}>
          <View style={styles.stepHeader}>
            <Text style={styles.stepTitle}>{t("setupWizard.step4.title")}</Text>
            <Text style={styles.stepSubtitle}>{t("setupWizard.step4.subtitle")}</Text>
          </View>

          <View style={styles.phasesCard}>
            <PhaseRow index="1" title={t("setupWizard.step3.phaseModel")} status="COMPLETE" t={t} />
            <PhaseRow index="2" title={t("setupWizard.step3.phaseEmbedding")} status="COMPLETE" t={t} />
            <PhaseRow
              index="3"
              title={t("setupWizard.step3.phaseKnowledgeBase")}
              status={indexingPhase === "ready" ? "COMPLETE" : "INDEXING"}
              t={t}
            />
          </View>

          {indexingPhase === "building" && seedProgress && (
            <View style={styles.progressCard}>
              <View style={styles.progressHeader}>
                <View style={styles.progressLeft}>
                  <ActivityIndicator size="small" color={colors.emerald[400]} />
                  <Text style={styles.progressTitle}>
                    {t("setupWizard.step4.counter", {
                      done: seedProgress.done.toLocaleString(),
                      total: seedProgress.total.toLocaleString(),
                    })}
                  </Text>
                </View>
                <Text style={styles.progressPctText}>
                  {Math.floor((seedProgress.done / seedProgress.total) * 100)}%
                </Text>
              </View>
              <Text style={styles.progressAssetLabel} numberOfLines={1}>
                {seedProgress.title}
              </Text>
              <View style={styles.progressTrack}>
                <View
                  style={[styles.progressFill, { width: `${Math.max((seedProgress.done / seedProgress.total) * 100, 3)}%` }]}
                />
              </View>
              <Text style={styles.telemetryEta}>
                {t("setupWizard.step3.eta", { eta: formatEta(seedEtaSeconds(seedProgress, seedStart.current), t("setupWizard.estimating")) })}
              </Text>
            </View>
          )}

          <View style={styles.tipBox}>
            <Text style={styles.tipLabel}>{t("setupWizard.step3.tipLabel")}</Text>
            <Text style={styles.tipText}>{t("setupWizard.step3.tipText")}</Text>
          </View>

          <View style={styles.actionsBottom}>
            {indexingPhase === "ready" || indexingPhase === "error" ? (
              <>
                {indexingPhase === "error" && (
                  <Text style={styles.waitingText}>{t("setupWizard.step3.indexingError", { error: indexingError })}</Text>
                )}
                <Pressable
                  style={[styles.primaryBtn, styles.launchBtn]}
                  onPress={() => {
                    notification(NotificationFeedbackType.Success);
                    onReady();
                  }}
                >
                  <Text style={styles.launchBtnText}>{t("setupWizard.step3.launchButton")}</Text>
                </Pressable>
              </>
            ) : (
              <View style={styles.waitingContainer}>
                <ActivityIndicator color={colors.emerald[400]} />
                <Text style={styles.waitingText}>{t("setupWizard.step3.buildingIndex")}</Text>
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </LinearGradient>
  );
}

function StepBadge({
  num,
  label,
  active,
  completed,
}: {
  num: number;
  label: string;
  active: boolean;
  completed: boolean;
}) {
  return (
    <View style={styles.stepBadgeWrapper}>
      <View
        style={[
          styles.stepCircle,
          active && styles.stepCircleActive,
          completed && styles.stepCircleCompleted,
        ]}
      >
        <Text
          style={[
            styles.stepNumber,
            (active || completed) && styles.stepNumberActive,
          ]}
        >
          {completed ? "✓" : num}
        </Text>
      </View>
      <Text style={[styles.stepLabel, active && styles.stepLabelActive]}>
        {label}
      </Text>
    </View>
  );
}

const PHASE_STATUS_KEYS: Record<string, string> = {
  COMPLETE: "setupWizard.phaseStatus.complete",
  STREAMING: "setupWizard.phaseStatus.streaming",
  INDEXING: "setupWizard.phaseStatus.indexing",
  PENDING: "setupWizard.phaseStatus.pending",
  QUEUED: "setupWizard.phaseStatus.queued",
};

function PhaseRow({
  index,
  title,
  status,
  t,
}: {
  index: string;
  title: string;
  status: "COMPLETE" | "STREAMING" | "INDEXING" | "PENDING" | "QUEUED";
  t: (key: string) => string;
}) {
  const isDone = status === "COMPLETE";
  const isInProgress = status === "STREAMING" || status === "INDEXING";

  return (
    <View style={styles.phaseRow}>
      <View style={styles.phaseLeft}>
        <View style={[styles.phaseIdx, isDone && styles.phaseIdxDone]}>
          <Text style={[styles.phaseIdxText, isDone && styles.phaseIdxTextDone]}>
            {isDone ? "✓" : index}
          </Text>
        </View>
        <Text style={styles.phaseTitle}>{title}</Text>
      </View>
      <View
        style={[
          styles.phaseStatusBadge,
          isDone && styles.phaseDoneBadge,
          isInProgress && styles.phaseProgressBadge,
        ]}
      >
        <Text
          style={[
            styles.phaseStatusText,
            isDone && styles.phaseDoneText,
            isInProgress && styles.phaseProgressText,
          ]}
        >
          {t(PHASE_STATUS_KEYS[status])}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  wizardProgressBar: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
    backgroundColor: colors.bg.surface,
  },
  stepsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepBadgeWrapper: {
    alignItems: "center",
    gap: 4,
  },
  stepCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: colors.border.subtle,
    alignItems: "center",
    justifyContent: "center",
  },
  stepCircleActive: {
    backgroundColor: colors.cyan.bgSubtle,
    borderColor: colors.cyan[500],
  },
  stepCircleCompleted: {
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald[500],
  },
  stepNumber: {
    ...typography.mono.xs,
    fontSize: 10,
    color: colors.text.dim,
    fontWeight: "700",
  },
  stepNumberActive: {
    color: "#FFFFFF",
  },
  stepLabel: {
    ...typography.mono.xs,
    fontSize: 8,
    color: colors.text.dim,
    letterSpacing: 0.5,
  },
  stepLabelActive: {
    color: colors.text.accentCyan,
    fontWeight: "700",
  },
  stepLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border.default,
    marginHorizontal: 8,
    marginBottom: 16,
  },
  stepLineCompleted: {
    backgroundColor: colors.emerald[500],
  },
  stepContent: {
    padding: spacing.md,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  mascotBanner: {
    alignItems: "center",
    paddingVertical: spacing.md,
    gap: 4,
  },
  mascotHero: {
    width: 68,
    height: 68,
    borderRadius: 16,
    marginBottom: 6,
  },
  heroTitle: {
    ...typography.ui.headline,
    color: colors.text.heading,
    letterSpacing: 1,
  },
  heroSubtitle: {
    ...typography.mono.xs,
    color: colors.text.accentEmerald,
    fontWeight: "800",
    letterSpacing: 1,
  },
  card: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
    paddingBottom: spacing.xs,
  },
  cardIcon: {
    fontSize: 14,
  },
  cardTitle: {
    ...typography.mono.xs,
    color: colors.text.heading,
    fontWeight: "800",
  },
  cardText: {
    ...typography.ui.body,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  hardwareSpecs: {
    backgroundColor: colors.bg.terminal,
    borderRadius: radii.md,
    padding: spacing.sm,
    gap: 6,
  },
  specRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  specLabel: {
    ...typography.ui.caption,
    color: colors.text.muted,
  },
  specValue: {
    ...typography.mono.sm,
    color: colors.text.heading,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  verifiedBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    gap: 6,
  },
  verifiedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.emerald[400],
  },
  verifiedText: {
    ...typography.mono.xs,
    fontSize: 9,
    fontWeight: "800",
    color: colors.text.accentEmerald,
  },
  stepHeader: {
    gap: 4,
    marginBottom: spacing.xs,
  },
  stepTitle: {
    ...typography.ui.title,
    color: colors.text.heading,
  },
  stepSubtitle: {
    ...typography.ui.caption,
    color: colors.text.muted,
  },
  tierCard: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.md,
    gap: 8,
  },
  tierCardActive: {
    borderColor: colors.cyan[500],
    backgroundColor: "rgba(6, 182, 212, 0.08)",
  },
  tierHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tierTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  tierName: {
    ...typography.ui.titleSm,
    color: colors.text.heading,
  },
  recommendedPill: {
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald.border,
    borderWidth: 1,
    borderRadius: radii.xs,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  recommendedText: {
    ...typography.mono.xs,
    fontSize: 8,
    color: colors.text.accentEmerald,
    fontWeight: "800",
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border.elevated,
    alignItems: "center",
    justifyContent: "center",
  },
  radioCircleActive: {
    borderColor: colors.cyan[500],
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.cyan[500],
  },
  tierDesc: {
    ...typography.ui.caption,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  tierMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  compatPillGreen: {
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald.border,
    borderWidth: 1,
    borderRadius: radii.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  compatPillGreenText: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.accentEmerald,
    fontWeight: "700",
  },
  heavyPill: {
    backgroundColor: colors.amber.bgSubtle,
    borderColor: colors.amber.border,
    borderWidth: 1,
    borderRadius: radii.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  heavyPillText: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.accentAmber,
    fontWeight: "700",
  },
  tierFootprint: {
    ...typography.mono.xs,
    color: colors.text.dim,
  },
  progressCard: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.md,
    gap: 8,
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  progressLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  progressTitle: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "800",
  },
  progressPctText: {
    ...typography.mono.sm,
    color: colors.text.heading,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  progressAssetLabel: {
    ...typography.mono.xs,
    color: colors.text.dim,
  },
  customizeWhileWaitingText: {
    ...typography.ui.caption,
    color: colors.text.secondary,
    lineHeight: 18,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  progressTrack: {
    height: 10,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderRadius: radii.xs,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.emerald[500],
    borderRadius: radii.xs,
  },
  telemetryMetricsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  telemetryBytes: {
    ...typography.mono.xs,
    color: colors.text.dim,
    fontVariant: ["tabular-nums"],
  },
  telemetryRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  telemetrySpeed: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "700",
  },
  telemetryDot: {
    ...typography.mono.xs,
    color: colors.text.dim,
  },
  telemetryEta: {
    ...typography.mono.xs,
    color: colors.text.accentAmber,
    fontWeight: "600",
  },
  phasesCard: {
    backgroundColor: colors.bg.terminal,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.sm,
    gap: 8,
  },
  phaseRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  phaseLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  phaseIdx: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  phaseIdxDone: {
    backgroundColor: colors.emerald.bgSubtle,
  },
  phaseIdxText: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.dim,
    fontWeight: "700",
  },
  phaseIdxTextDone: {
    color: colors.text.accentEmerald,
  },
  phaseTitle: {
    ...typography.ui.caption,
    color: colors.text.heading,
  },
  phaseStatusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.xs,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  phaseDoneBadge: {
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald.border,
    borderWidth: 1,
  },
  phaseProgressBadge: {
    backgroundColor: colors.cyan.bgSubtle,
    borderColor: colors.cyan.border,
    borderWidth: 1,
  },
  phaseStatusText: {
    ...typography.mono.xs,
    fontSize: 8,
    color: colors.text.dim,
    fontWeight: "700",
  },
  phaseDoneText: {
    color: colors.text.accentEmerald,
  },
  phaseProgressText: {
    color: colors.text.accentCyan,
  },
  tipBox: {
    backgroundColor: "rgba(6, 182, 212, 0.06)",
    borderColor: colors.cyan.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.sm,
    gap: 4,
  },
  tipLabel: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "700",
  },
  tipText: {
    ...typography.ui.caption,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  errorBox: {
    backgroundColor: colors.crimson.bgSubtle,
    borderColor: colors.crimson.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.sm,
    gap: 6,
  },
  errorLabel: {
    ...typography.mono.xs,
    color: colors.crimson[400],
    fontWeight: "700",
  },
  errorText: {
    ...typography.ui.caption,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  retryBtn: {
    marginTop: 4,
    backgroundColor: colors.crimson[600],
    borderRadius: radii.sm,
    paddingVertical: 10,
    alignItems: "center",
  },
  retryBtnText: {
    ...typography.ui.titleSm,
    color: "#FFFFFF",
    fontWeight: "800",
  },
  restartAllBtn: {
    alignSelf: "center",
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  restartAllBtnText: {
    ...typography.mono.xs,
    color: colors.text.dim,
    textDecorationLine: "underline",
  },
  actionsBottom: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  primaryBtn: {
    backgroundColor: colors.emerald[600],
    borderRadius: radii.md,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    ...typography.ui.titleSm,
    color: "#FFFFFF",
    fontWeight: "800",
  },
  launchBtn: {
    backgroundColor: colors.emerald[500],
  },
  launchBtnText: {
    ...typography.ui.title,
    color: "#FFFFFF",
    fontWeight: "800",
  },
  waitingContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: 12,
  },
  waitingText: {
    ...typography.mono.xs,
    color: colors.text.accentEmerald,
  },
  textBtn: {
    alignItems: "center",
    paddingVertical: 6,
  },
  textBtnText: {
    ...typography.ui.caption,
    color: colors.text.dim,
  },
});
