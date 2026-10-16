import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  View,
  StyleSheet,
  FlatList,
  Pressable,
  ScrollView,
  Modal,
  ActivityIndicator,
  Switch,
} from "react-native";
import { Text } from "./components/AppText";
import { impact, notification, ImpactFeedbackStyle, NotificationFeedbackType, setHapticsEnabledCache } from "../services/haptics";
import { useTranslation } from "react-i18next";
import { MODEL_CATALOG, CatalogModel, AssetKind, REQUIRED_MODELS } from "../models/manifest";
import { llamaEngine } from "../inference/LlamaEngine";
import { ModelManager } from "../models/ModelManager";
import { getActiveModelId, setActiveModelId, getHapticsEnabled, setHapticsEnabled, resetPreferences, getShowLiveStats, setShowLiveStats } from "../models/settings";
import { seedKnowledgeBaseIfEmpty } from "../rag/seedCorpus";
import { closePack } from "../rag/packs";
import {
  startDownload,
  getDownloadState,
  isDownloading,
  subscribeDownloads,
} from "../services/downloadManager";
import { listDiscoveredModels, removeDiscoveredModel } from "../models/discoveredModels";
import { resetAllAppData } from "../services/appReset";
import { CatalogItemCard, CatalogRowState } from "./CatalogItemCard";
import { ModelBrowser } from "./ModelBrowser";
import { listedModels } from "./modelList";
import { PersonalitySettings } from "./PersonalitySettings";
import { UsageStatsContent } from "./UsageStatsContent";
import { VoiceSettings } from "./VoiceSettings";
import { LibraryShare, LibraryShareSettings } from "./LibraryShareSettings";
import { FolderWatchSettings } from "./FolderWatchSettings";
import { folderWatchAvailable } from "../services/folderWatch";
import { SecuritySettings } from "./SecuritySettings";
import { pinLockAvailable } from "../services/pinLock";
import { ApiServerSettings } from "./ApiServerSettings";
import { apiServerAvailable } from "../services/apiServer";
import { MemorySettings } from "./MemorySettings";
import { AccordionSection } from "./AccordionSection";
import { SetupWizardScreen } from "./SetupWizardScreen";
import { ThemeSelector } from "./components/ThemeSelector";
import { LanguageSelector } from "./components/LanguageSelector";
import { Toast } from "./Toast";
import { useTheme, colors, typography } from "./theme";
import { spacing, radii } from "./theme/spacing";

const modelManager = new ModelManager();
const LLM_EMBEDDING_KINDS: AssetKind[] = ["llm", "embedding"];

type Props =
  | { mode: "required"; onReady: () => void }
  | { mode: "optional"; onClose: () => void; onRelaunchWizard?: () => void; onOpenKnowledge?: () => void };

/**
 * ModelSetupScreen handles two operational modes:
 * - "required": First-run onboarding flow using SetupWizardScreen (Hardware Diagnostics ➔ Model Tier ➔ Local Indexing).
 * - "optional": Field Settings dashboard (Tone, Model Catalog, Offline Knowledge Base, Telemetry, and Danger Zone).
 */
export function ModelSetupScreen(props: Props) {
  const { colors, typography, setTheme, setFontScale } = useTheme();
  const { t } = useTranslation();
  const requiredMode = props.mode === "required";
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [activeIds, setActiveIds] = useState<Partial<Record<AssetKind, string>>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<CatalogModel[]>([]);
  const [dangerModalVisible, setDangerModalVisible] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [, forceRender] = useState(0);
  const [hapticsEnabled, setHapticsEnabledState] = useState(true);
  const [showTech, setShowTechState] = useState(true);
  const [showHfPage, setShowHfPage] = useState(false);

  const refreshDiscovered = useCallback(async () => {
    const models = await listDiscoveredModels();
    setDiscoveredModels(models);
    const statuses = await Promise.all(models.map((m) => modelManager.statusOf(m)));
    setPresence((prev) => ({
      ...prev,
      ...Object.fromEntries(statuses.map((s) => [s.asset.id, s.present])),
    }));
  }, []);

  useEffect(() => subscribeDownloads(() => forceRender((n) => n + 1)), []);

  const refreshStatus = useCallback(async () => {
    const statuses = await modelManager.statusAll();
    // Merge, not replace: replacing drops discovered models' presence until
    // refreshDiscovered() below restores it, flashing their Download button.
    setPresence((prev) => ({ ...prev, ...Object.fromEntries(statuses.map((s) => [s.asset.id, s.present])) }));
    await refreshDiscovered();

    const next: Partial<Record<AssetKind, string>> = {};
    for (const kind of LLM_EMBEDDING_KINDS) {
      const active = await getActiveModelId(kind);
      next[kind] = active ?? MODEL_CATALOG.find((m) => m.kind === kind && m.required)?.id;
    }
    setActiveIds(next);

    return statuses;
  }, [refreshDiscovered]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    getHapticsEnabled().then(setHapticsEnabledState);
    getShowLiveStats().then(setShowTechState);
  }, []);

  const toggleShowTech = useCallback(async (value: boolean) => {
    setShowTechState(value);
    await setShowLiveStats(value);
  }, []);

  const toggleHaptics = useCallback(async (value: boolean) => {
    setHapticsEnabledState(value);
    // Cache update happens immediately, not just after the persisted
    // write resolves — a haptic tap could otherwise fire once more (or
    // not fire) between flipping the switch and setHapticsEnabled()
    // finishing, since src/services/haptics.ts reads from an in-memory
    // cache, not settings.ts, on every tap.
    setHapticsEnabledCache(value);
    await setHapticsEnabled(value);
  }, []);

  const getRow = useCallback(
    (item: CatalogModel): CatalogRowState => {
      const dl = getDownloadState(item.id);
      return {
        present: presence[item.id] ?? false,
        downloading: isDownloading(item.id),
        progress: dl?.progress ?? 0,
        error: dl?.error ?? null,
        bytesWritten: dl?.bytesWritten,
        bytesExpected: dl?.bytesExpected,
        speedBytesPerSec: dl?.speedBytesPerSec,
        etaSeconds: dl?.etaSeconds,
      };
    },
    [presence]
  );

  const download = useCallback(
    async (model: CatalogModel) => {
      impact(ImpactFeedbackStyle.Medium);
      await startDownload(model);
      await refreshStatus();

      if (model.kind === "corpus" && !requiredMode && !getDownloadState(model.id)?.error) {
        await seedKnowledgeBaseIfEmpty();
        setToast(t("modelSetupScreen.toasts.indexed", { name: model.label }));
      }
    },
    [requiredMode, refreshStatus, t]
  );

  const remove = useCallback(
    async (model: CatalogModel) => {
      if (model.format === "sqlite-pack") await closePack(model.id);
      await modelManager.deleteModel(model);
      if (model.id.startsWith("hf-")) {
        await removeDiscoveredModel(model.id);
      }
      await refreshStatus();
      setToast(t("modelSetupScreen.toasts.removed", { name: model.label }));
    },
    [refreshStatus, t]
  );

  // Id of the LLM being loaded after "Use"; blocks other Use/delete/Done until it's ready.
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const useModel = useCallback(
    async (model: CatalogModel) => {
      if (activatingId) return;
      impact(ImpactFeedbackStyle.Light);
      if (model.kind !== "llm") {
        await setActiveModelId(model.kind, model.id);
        await refreshStatus();
        setToast(t("modelSetupScreen.toasts.activeSet", { kind: model.kind, name: model.label }));
        return;
      }
      // Load it here, so the chat is ready on return and a failure shows
      // next to the model that caused it.
      const previousId =
        (await getActiveModelId("llm")) ?? REQUIRED_MODELS.find((m) => m.kind === "llm")!.id;
      setActivatingId(model.id);
      await setActiveModelId("llm", model.id);
      try {
        await llamaEngine.load(model.filename);
        setToast(t("modelSetupScreen.toasts.activeSet", { kind: model.kind, name: model.label }));
      } catch (e: any) {
        // Keep the previous model active; the chat reloads it on return.
        await setActiveModelId("llm", previousId);
        setToast(t("modelSetupScreen.toasts.loadFailed", { name: model.label, error: e?.message ?? String(e) }));
      } finally {
        setActivatingId(null);
        await refreshStatus();
      }
    },
    [activatingId, refreshStatus, t]
  );

  const onRelaunchWizard = !requiredMode
    ? (props as { onRelaunchWizard?: () => void }).onRelaunchWizard
    : undefined;

  const handleExecuteReset = async () => {
    notification(NotificationFeedbackType.Warning);
    setResetting(true);
    try {
      await resetAllAppData();
      setDangerModalVisible(false);
      onRelaunchWizard?.();
    } catch (e: any) {
      setResetting(false);
      setToast(t("modelSetupScreen.toasts.resetFailed", { error: e?.message ?? e }));
    }
  };

  // Defaults back without the re-download "Purge all data" costs; setup opens so the chat starts from them.
  const handleResetSettings = () => {
    Alert.alert(t("modelSetupScreen.recovery.resetConfirmTitle"), t("modelSetupScreen.recovery.resetConfirmBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("modelSetupScreen.recovery.resetConfirmButton"),
        style: "destructive",
        onPress: async () => {
          await resetPreferences();
          setHapticsEnabledCache(true);
          await setTheme("campfire");
          await setFontScale("standard");
          onRelaunchWizard?.();
        },
      },
    ]);
  };

  // If required on first run, display the 3-step Setup Wizard!
  if (requiredMode) {
    return <SetupWizardScreen onReady={(props as { onReady: () => void }).onReady} />;
  }

  // Optional mode: Settings Screen
  return (
    <View style={styles.container}>
      {/* Settings Top Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View>
            <Text style={styles.title}>{t("modelSetupScreen.header.title")}</Text>
            <Text style={styles.subtitle}>{t("modelSetupScreen.header.subtitle")}</Text>
          </View>
        </View>
        <Pressable
          style={[styles.closeBtn, activatingId !== null && { opacity: 0.4 }]}
          onPress={(props as { onClose: () => void }).onClose}
          disabled={activatingId !== null}
          hitSlop={8}
        >
          <Text style={styles.closeBtnText}>{t("common.done")}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.accordionScroll}>
        <AccordionSection title={t("modelSetupScreen.sections.tone")}>
          <PersonalitySettings />
        </AccordionSection>

        <AccordionSection title={t("modelSetupScreen.sections.models")}>
          <Text style={styles.sectionHeading}>{t("modelSetupScreen.installedModels")}</Text>
          <FlatList
            data={listedModels(MODEL_CATALOG, discoveredModels, presence, activeIds)}
            keyExtractor={(m) => m.id}
            scrollEnabled={false}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <CatalogItemCard
                item={item}
                row={getRow(item)}
                isActive={activeIds[item.kind] === item.id}
                onDownload={download}
                onUse={useModel}
                onRemove={remove}
                activating={activatingId === item.id}
                busy={activatingId !== null}
              />
            )}
          />

          <Text style={styles.sectionHeading}>{t("modelSetupScreen.discoverHfModels")}</Text>
          <Pressable style={styles.linkBtn} onPress={() => setShowHfPage(true)}>
            <Text style={styles.linkBtnText}>{t("modelBrowser.open")}</Text>
          </Pressable>
        </AccordionSection>

        <AccordionSection title={t("modelSetupScreen.sections.knowledgeBase")}>
          {/* Packs and documents live on the Knowledge screen now (as the native app). */}
          <Text style={styles.linkNote}>{t("modelSetupScreen.knowledgeMoved")}</Text>
          <Pressable style={styles.linkBtn} onPress={() => {
              const p = props as { onClose: () => void; onOpenKnowledge?: () => void };
              p.onOpenKnowledge?.();
              p.onClose();
            }}>
            <Text style={styles.linkBtnText}>{t("modelSetupScreen.openKnowledge")}</Text>
          </Pressable>
        </AccordionSection>

        <AccordionSection title={t("modelSetupScreen.sections.memory")}>
          <MemorySettings />
        </AccordionSection>

        {showTech && (
          <AccordionSection title={t("modelSetupScreen.sections.telemetry")}>
            <UsageStatsContent />
          </AccordionSection>
        )}

        <AccordionSection title={t("modelSetupScreen.sections.displayTheme")}>
          <View style={styles.themeSectionWrapper}>
            <ThemeSelector />
          </View>
          <View style={styles.hapticRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.hapticRowLabel}>{t("interfaceSettings.hapticFeedbackLabel")}</Text>
              <Text style={styles.hapticRowValue}>{t("interfaceSettings.hapticFeedbackValue")}</Text>
            </View>
            <Switch
              value={hapticsEnabled}
              onValueChange={toggleHaptics}
              trackColor={{ false: colors.border.default, true: colors.emerald[500] }}
            />
          </View>
          <View style={styles.hapticRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.hapticRowLabel}>{t("interfaceSettings.technicalDetailsLabel")}</Text>
              <Text style={styles.hapticRowValue}>{t("interfaceSettings.technicalDetailsValue")}</Text>
            </View>
            <Switch
              value={showTech}
              onValueChange={toggleShowTech}
              trackColor={{ false: colors.border.default, true: colors.emerald[500] }}
            />
          </View>
        </AccordionSection>

        <AccordionSection title={t("modelSetupScreen.sections.language")}>
          <View style={styles.themeSectionWrapper}>
            <LanguageSelector />
          </View>
        </AccordionSection>

        <AccordionSection title={t("modelSetupScreen.sections.voice")}>
          <VoiceSettings />
        </AccordionSection>

        {LibraryShare && (
          <AccordionSection title={t("modelSetupScreen.sections.libraryShare")}>
            <LibraryShareSettings />
          </AccordionSection>
        )}

        {folderWatchAvailable() && (
          <AccordionSection title={t("modelSetupScreen.sections.folderWatch")}>
            <FolderWatchSettings />
          </AccordionSection>
        )}

        {apiServerAvailable() && (
          <AccordionSection title={t("modelSetupScreen.sections.apiServer")}>
            <ApiServerSettings />
          </AccordionSection>
        )}

        {pinLockAvailable() && (
          <AccordionSection title={t("modelSetupScreen.sections.security")}>
            <SecuritySettings />
          </AccordionSection>
        )}

        {/* RECOVERY & DANGER ZONE SECTION */}
        <AccordionSection title={t("modelSetupScreen.sections.recovery")}>
          <View style={styles.recoveryContainer}>
            {/* Setup Wizard Shortcut */}
            <View style={styles.recoveryCard}>
              <View style={styles.recoveryHeader}>
                <Text style={styles.recoveryTitle}>{t("modelSetupScreen.recovery.wizardTitle")}</Text>
              </View>
              <Text style={styles.recoveryDesc}>{t("modelSetupScreen.recovery.wizardDesc")}</Text>
              <Pressable
                style={styles.wizardBtn}
                onPress={() => onRelaunchWizard?.()}
                disabled={!onRelaunchWizard}
              >
                <Text style={styles.wizardBtnText}>{t("modelSetupScreen.recovery.wizardButton")}</Text>
              </Pressable>
            </View>

            <View style={styles.recoveryCard}>
              <View style={styles.recoveryHeader}>
                <Text style={styles.recoveryTitle}>{t("modelSetupScreen.recovery.resetTitle")}</Text>
              </View>
              <Text style={styles.recoveryDesc}>{t("modelSetupScreen.recovery.resetDesc")}</Text>
              <Pressable style={styles.wizardBtn} onPress={handleResetSettings}>
                <Text style={styles.wizardBtnText}>{t("modelSetupScreen.recovery.resetButton")}</Text>
              </Pressable>
            </View>

            {/* Danger Zone Card */}
            <View style={styles.dangerZoneCard}>
              <View style={styles.dangerHeader}>
                <View style={styles.dangerBadge}>
                  <Text style={styles.dangerBadgeText}>{t("modelSetupScreen.recovery.dangerBadge")}</Text>
                </View>
              </View>
              <Text style={styles.dangerDesc}>{t("modelSetupScreen.recovery.dangerDesc")}</Text>
              <Pressable
                style={styles.dangerActionBtn}
                onPress={() => {
                  impact(ImpactFeedbackStyle.Heavy);
                  setDangerModalVisible(true);
                }}
              >
                <Text style={styles.dangerActionBtnText}>{t("modelSetupScreen.recovery.dangerButton")}</Text>
              </Pressable>
            </View>
          </View>
        </AccordionSection>
      </ScrollView>

      {/* High-Impact Danger Confirmation Modal */}
      <Modal
        visible={dangerModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDangerModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalIconCircle}>
              <Text style={styles.modalIconText}>⚠️</Text>
            </View>
            <Text style={styles.modalTitle}>{t("modelSetupScreen.dangerModal.title")}</Text>
            <Text style={styles.modalSubtitle}>{t("modelSetupScreen.dangerModal.subtitle")}</Text>

            {/* Itemized consequences list */}
            <View style={styles.consequencesBox}>
              <Text style={styles.consequencesHeader}>{t("modelSetupScreen.dangerModal.consequencesHeader")}</Text>
              <View style={styles.consequenceItem}>
                <Text style={styles.consequenceBullet}>•</Text>
                <Text style={styles.consequenceText}>{t("modelSetupScreen.dangerModal.consequenceModels")}</Text>
              </View>
              <View style={styles.consequenceItem}>
                <Text style={styles.consequenceBullet}>•</Text>
                <Text style={styles.consequenceText}>{t("modelSetupScreen.dangerModal.consequenceEmbeddings")}</Text>
              </View>
              <View style={styles.consequenceItem}>
                <Text style={styles.consequenceBullet}>•</Text>
                <Text style={styles.consequenceText}>{t("modelSetupScreen.dangerModal.consequenceHistory")}</Text>
              </View>
            </View>

            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancelBtn}
                onPress={() => setDangerModalVisible(false)}
                disabled={resetting}
              >
                <Text style={styles.modalCancelText}>{t("common.cancel")}</Text>
              </Pressable>
              <Pressable
                style={[styles.modalConfirmBtn, resetting && styles.modalConfirmBtnDisabled]}
                onPress={handleExecuteReset}
                disabled={resetting}
              >
                {resetting ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.modalConfirmText}>{t("modelSetupScreen.dangerModal.confirmButton")}</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Hugging Face models on a page of their own (as the native app), over Settings so it comes back as it was. */}
      {showHfPage && (
        <View style={[StyleSheet.absoluteFill, styles.container]}>
          <View style={styles.header}>
            <Text style={styles.title}>{t("modelBrowser.pageTitle")}</Text>
            <Pressable style={styles.closeBtn} onPress={() => setShowHfPage(false)} hitSlop={8}>
              <Text style={styles.closeBtnText}>{t("common.done")}</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.browserWrapper}>
            <Text style={styles.linkNote}>{t("modelBrowser.pageNote")}</Text>
            <ModelBrowser onAdded={refreshDiscovered} />
          </ScrollView>
        </View>
      )}
      {toast && <Toast message={toast} onHide={() => setToast(null)} />}
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
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    ...typography.ui.titleSm,
    color: colors.text.heading,
    letterSpacing: 0.5,
  },
  subtitle: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.dim,
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.sm,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  closeBtnText: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "800",
  },
  accordionScroll: {
    paddingBottom: spacing.xxxl,
  },
  sectionHeading: {
    ...typography.mono.xs,
    color: colors.text.dim,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  list: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  linkNote: { color: colors.text.muted, fontSize: 12, lineHeight: 17, marginHorizontal: spacing.md, marginTop: 6 },
  linkBtn: {
    marginHorizontal: spacing.md,
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border.default,
    alignItems: "center",
  },
  linkBtnText: { color: colors.text.accentCyan, fontWeight: "700" },
  browserWrapper: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  themeSectionWrapper: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  hapticRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
  },
  hapticRowLabel: {
    ...typography.ui.subtext,
    color: colors.text.heading,
    fontWeight: "700",
  },
  hapticRowValue: {
    ...typography.mono.xs,
    fontSize: 10,
    color: colors.text.dim,
    marginTop: 2,
  },
  recoveryContainer: {
    padding: spacing.md,
    gap: spacing.md,
  },
  recoveryCard: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.md,
    gap: spacing.sm,
  },
  recoveryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  recoveryTitle: {
    ...typography.mono.xs,
    color: colors.text.heading,
    fontWeight: "800",
  },
  recoveryDesc: {
    ...typography.ui.caption,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  wizardBtn: {
    backgroundColor: colors.cyan.bgSubtle,
    borderColor: colors.cyan.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: 10,
    alignItems: "center",
  },
  wizardBtnText: {
    ...typography.ui.titleSm,
    fontSize: 12,
    color: colors.text.accentCyan,
  },
  dangerZoneCard: {
    backgroundColor: "rgba(239, 68, 68, 0.06)",
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.crimson.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  dangerHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  dangerBadge: {
    backgroundColor: colors.crimson.bgSubtle,
    borderColor: colors.crimson[500],
    borderWidth: 1,
    borderRadius: radii.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  dangerBadgeText: {
    ...typography.mono.xs,
    fontSize: 8,
    color: colors.crimson[400],
    fontWeight: "800",
  },
  dangerDesc: {
    ...typography.ui.caption,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  dangerActionBtn: {
    backgroundColor: colors.crimson[600],
    borderRadius: radii.md,
    paddingVertical: 12,
    alignItems: "center",
  },
  dangerActionBtnText: {
    ...typography.ui.titleSm,
    fontSize: 13,
    color: "#FFFFFF",
    fontWeight: "800",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.82)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.crimson.border,
    padding: spacing.lg,
    alignItems: "center",
    gap: spacing.sm,
  },
  modalIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.crimson.bgSubtle,
    borderWidth: 1,
    borderColor: colors.crimson[500],
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  modalIconText: {
    fontSize: 22,
  },
  modalTitle: {
    ...typography.ui.title,
    color: colors.crimson[400],
    letterSpacing: 0.5,
  },
  modalSubtitle: {
    ...typography.ui.caption,
    color: colors.text.muted,
    textAlign: "center",
  },
  consequencesBox: {
    width: "100%",
    backgroundColor: colors.bg.terminal,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.sm,
    gap: 6,
    marginVertical: 4,
  },
  consequencesHeader: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.dim,
    fontWeight: "700",
  },
  consequenceItem: {
    flexDirection: "row",
    gap: 6,
  },
  consequenceBullet: {
    color: colors.crimson[400],
    fontWeight: "700",
  },
  consequenceText: {
    ...typography.ui.caption,
    color: colors.text.secondary,
    flex: 1,
    lineHeight: 16,
  },
  modalActions: {
    flexDirection: "row",
    gap: spacing.sm,
    width: "100%",
    marginTop: spacing.xs,
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: radii.md,
    paddingVertical: 12,
    alignItems: "center",
  },
  modalCancelText: {
    ...typography.ui.titleSm,
    color: colors.text.heading,
  },
  modalConfirmBtn: {
    flex: 1,
    backgroundColor: colors.crimson[600],
    borderRadius: radii.md,
    paddingVertical: 12,
    alignItems: "center",
  },
  modalConfirmBtnDisabled: {
    opacity: 0.5,
  },
  modalConfirmText: {
    ...typography.ui.titleSm,
    color: "#FFFFFF",
    fontWeight: "800",
  },
});
