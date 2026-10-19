/**
 * Agent profiles: a name, a tone (src/constants/personalities.ts), what it answers from (some personal collections or
 * the whole library) and the boar's look (mascot/art.ts). Create, edit, delete, and start a conversation with one.
 * Saved in the app's settings (src/models/settings.ts agentProfiles).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "./components/AppText";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";
import { AgentProfile, getAgentProfiles, setAgentProfiles } from "../models/settings";
import { offeredStyles, getPersonality } from "../constants/personalities";
import { listCustomCollections } from "../services/documentImporter";
import type { CustomCollection } from "../rag/db";
import { MASCOT_ART } from "./mascot/art";
import { STAGES, type GrowthStage } from "./mascot/growth";

const DEFAULT_ART = require("../../assets/mascot.png");

export function ProfilesScreen({ onClose, onStart }: { onClose: () => void; onStart: (profile: AgentProfile) => void }) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [collections, setCollections] = useState<CustomCollection[]>([]);
  /** The profile being edited (a new one has an id not in the list yet). */
  const [draft, setDraft] = useState<AgentProfile | null>(null);

  useEffect(() => {
    getAgentProfiles().then(setProfiles);
    listCustomCollections().then(setCollections).catch(() => {});
  }, []);

  const save = useCallback(async (next: AgentProfile[]) => {
    setProfiles(next);
    await setAgentProfiles(next);
  }, []);

  const blank = (): AgentProfile => ({ id: `p-${Date.now()}`, name: "", personalityId: "succinct", collections: null });
  // ponytail: one suggested example, filled into the form; nothing is created until the user saves.
  const example = (): AgentProfile => ({
    ...blank(),
    name: t("profiles.exampleName"),
    collections: collections.length ? collections.map((c) => c.id) : null,
    stage: "adulto",
  });

  const submit = async () => {
    if (!draft || !draft.name.trim()) return;
    const p = { ...draft, name: draft.name.trim() };
    await save(profiles.some((x) => x.id === p.id) ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p]);
    setDraft(null);
  };

  const remove = (p: AgentProfile) =>
    Alert.alert(t("profiles.deleteTitle"), t("profiles.deleteMessage", { name: p.name }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.remove"), style: "destructive", onPress: () => void save(profiles.filter((x) => x.id !== p.id)).then(() => setDraft(null)) },
    ]);

  const scopeLabel = (p: AgentProfile) => {
    if (!p.collections) return t("profiles.wholeLibrary");
    const names = collections.filter((c) => p.collections!.includes(c.id)).map((c) => c.name);
    return names.length ? names.join(", ") : t("scope.removed");
  };
  const art = (stage?: GrowthStage) => (stage ? MASCOT_ART[stage].image : DEFAULT_ART);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("profiles.title")}</Text>
        <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>{t("common.done")}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {draft ? (
          <View style={styles.card}>
            <Text style={styles.label}>{t("profiles.name")}</Text>
            <TextInput
              style={styles.input}
              value={draft.name}
              onChangeText={(name) => setDraft({ ...draft, name })}
              placeholder={t("profiles.namePlaceholder")}
              placeholderTextColor={colors.text.dim}
            />

            <Text style={styles.label}>{t("profiles.personality")}</Text>
            <View style={styles.chips}>
              {offeredStyles(draft.personalityId).map((p) => (
                <Chip key={p.id} on={draft.personalityId === p.id} onPress={() => setDraft({ ...draft, personalityId: p.id })}>
                  {`${p.icon} ${t(`personalities.${p.id}.label`)}`}
                </Chip>
              ))}
            </View>
            {draft.personalityId === "custom" && (
              <>
                <Text style={styles.hint}>{t("profiles.customPromptHint")}</Text>
                <TextInput
                  style={[styles.input, styles.promptInput]}
                  value={draft.customPrompt ?? ""}
                  onChangeText={(customPrompt) => setDraft({ ...draft, customPrompt })}
                  placeholder={t("personalitySettings.customPromptPlaceholder")}
                  placeholderTextColor={colors.text.dim}
                  accessibilityLabel={t("personalitySettings.customPromptPlaceholder")}
                  multiline
                />
              </>
            )}

            <Text style={styles.label}>{t("profiles.scope")}</Text>
            <View style={styles.chips}>
              <Chip on={!draft.collections} onPress={() => setDraft({ ...draft, collections: null })}>
                {`📚 ${t("profiles.wholeLibrary")}`}
              </Chip>
              {collections.map((c) => {
                const on = !!draft.collections?.includes(c.id);
                const toggle = () => {
                  const next = on ? draft.collections!.filter((id) => id !== c.id) : [...(draft.collections ?? []), c.id];
                  setDraft({ ...draft, collections: next.length ? next : null });
                };
                return (
                  <Chip key={c.id} on={on} onPress={toggle}>
                    {`📄 ${c.name}`}
                  </Chip>
                );
              })}
            </View>
            {collections.length === 0 && <Text style={styles.hint}>{t("profiles.noCollections")}</Text>}

            <Text style={styles.label}>{t("profiles.look")}</Text>
            <View style={styles.chips}>
              {[undefined, ...STAGES.map((s) => s.id)].map((stage) => (
                <Pressable
                  key={stage ?? "growth"}
                  onPress={() => setDraft({ ...draft, stage })}
                  style={[styles.artOption, draft.stage === stage && styles.artOptionOn]}
                  accessibilityRole="button"
                  accessibilityLabel={stage ? t(`mascot.stage.${stage}`) : t("profiles.lookGrows")}
                >
                  <Image source={art(stage)} style={styles.artImg} resizeMode="contain" />
                  <Text style={styles.artLabel} numberOfLines={2}>
                    {stage ? t(`mascot.stage.${stage}`) : t("profiles.lookGrows")}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.row}>
              <Pressable style={[styles.primaryBtn, !draft.name.trim() && styles.disabled]} onPress={submit} disabled={!draft.name.trim()}>
                <Text style={styles.primaryBtnText}>{t("profiles.save")}</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={() => setDraft(null)}>
                <Text style={styles.secondaryBtnText}>{t("common.cancel")}</Text>
              </Pressable>
              {profiles.some((x) => x.id === draft.id) && (
                <Pressable style={styles.secondaryBtn} onPress={() => remove(draft)}>
                  <Text style={[styles.secondaryBtnText, { color: colors.crimson[400] }]}>{t("common.remove")}</Text>
                </Pressable>
              )}
            </View>
          </View>
        ) : (
          <>
            <Text style={styles.hint}>{t("profiles.hint")}</Text>
            {profiles.map((p) => (
              <View key={p.id} style={styles.card}>
                <View style={styles.profileRow}>
                  <Image source={art(p.stage)} style={styles.avatar} resizeMode="contain" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.profileName}>{p.name}</Text>
                    <Text style={styles.meta} numberOfLines={2}>
                      {`${getPersonality(p.personalityId).icon} ${t(`personalities.${p.personalityId}.label`)} · ${scopeLabel(p)}`}
                    </Text>
                  </View>
                </View>
                <View style={styles.row}>
                  <Pressable style={styles.primaryBtn} onPress={() => onStart(p)} accessibilityRole="button">
                    <Text style={styles.primaryBtnText}>💬 {t("profiles.start")}</Text>
                  </Pressable>
                  <Pressable style={styles.secondaryBtn} onPress={() => setDraft(p)}>
                    <Text style={styles.secondaryBtnText}>{t("profiles.edit")}</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            <View style={styles.row}>
              <Pressable style={styles.primaryBtn} onPress={() => setDraft(blank())}>
                <Text style={styles.primaryBtnText}>＋ {t("profiles.create")}</Text>
              </Pressable>
              {profiles.length === 0 && (
                <Pressable style={styles.secondaryBtn} onPress={() => setDraft(example())}>
                  <Text style={styles.secondaryBtnText}>{t("profiles.useExample")}</Text>
                </Pressable>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Chip({ on, onPress, children }: { on: boolean; onPress: () => void; children: string }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{children}</Text>
    </Pressable>
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
  title: { ...typography.ui.titleSm, color: colors.text.heading },
  closeBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radii.xs, backgroundColor: "rgba(255, 255, 255, 0.08)" },
  closeBtnText: { ...typography.mono.xs, color: colors.text.accentCyan, fontWeight: "800" },
  body: { padding: 12, gap: 10, paddingBottom: spacing.xxxl },
  hint: { color: colors.text.muted, fontSize: 12, lineHeight: 17 },
  card: { backgroundColor: colors.bg.card, borderRadius: 10, padding: 12, gap: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  label: { color: colors.text.heading, fontSize: 13, fontWeight: "700", marginTop: 4 },
  input: { backgroundColor: colors.bg.cardHover, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, color: colors.text.primary, fontSize: 13 },
  promptInput: { minHeight: 90, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 12, paddingVertical: 6 },
  chipOn: { backgroundColor: colors.emerald.bgSubtle, borderColor: colors.emerald.border },
  chipText: { color: colors.text.muted, fontSize: 12 },
  chipTextOn: { color: colors.text.accentEmerald, fontWeight: "700" },
  artOption: { width: 84, alignItems: "center", gap: 4, padding: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default },
  artOptionOn: { backgroundColor: colors.emerald.bgSubtle, borderColor: colors.emerald.border },
  artImg: { width: 56, height: 56 },
  artLabel: { color: colors.text.muted, fontSize: 10, textAlign: "center" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 4 },
  primaryBtn: { backgroundColor: colors.emerald[600], borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
  primaryBtnText: { color: colors.text.heading, fontWeight: "700", fontSize: 13 },
  secondaryBtn: { backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
  secondaryBtnText: { color: colors.text.accentCyan, fontWeight: "600", fontSize: 13 },
  disabled: { opacity: 0.5 },
  profileRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 48, height: 48 },
  profileName: { color: colors.text.primary, fontSize: 15, fontWeight: "700" },
  meta: { color: colors.text.accentEmerald, fontSize: 12 },
});
