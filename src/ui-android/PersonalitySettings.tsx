import React, { useEffect, useState } from "react";
import { View, StyleSheet, Pressable, Switch } from "react-native";
import { colors } from "./theme/colors";
import { Text, TextInput } from "./components/AppText";
import { useTranslation } from "react-i18next";
import { DEFAULT_PERSONALITY_ID, offeredStyles, PersonalityId, MAX_TOKENS_OPTIONS } from "../constants/personalities";
import {
  getPersonalityId,
  setPersonalityId,
  getCustomSystemPrompt,
  setCustomSystemPrompt,
  getMaxTokensChoice,
  autoMaxTokens,
  setMaxTokens,
  getDeepResearchMode,
  setDeepResearchMode,
  getAdaptiveRoutingEnabled,
  setAdaptiveRoutingEnabled,
} from "../models/settings";

/**
 * "Assistant Tone & Response Style" section of the Settings screen. Purely
 * local state (src/models/settings.ts) — no network, no model reload
 * needed, since the system prompt/max-tokens are applied per-generation in
 * ChatScreen.send(), not baked into the loaded model.
 */
export function PersonalitySettings() {
  const { t } = useTranslation();
  const [personalityId, setPersonalityIdState] = useState<PersonalityId>(DEFAULT_PERSONALITY_ID);
  const [customPrompt, setCustomPromptState] = useState("");
  const [maxTokens, setMaxTokensState] = useState<number | undefined>(undefined); // undefined: Auto
  const [deepResearch, setDeepResearchState] = useState(false);
  const [adaptiveRouting, setAdaptiveRoutingState] = useState(false);

  useEffect(() => {
    (async () => {
      setPersonalityIdState(await getPersonalityId());
      setCustomPromptState(await getCustomSystemPrompt());
      setMaxTokensState(await getMaxTokensChoice());
      setDeepResearchState(await getDeepResearchMode());
      setAdaptiveRoutingState(await getAdaptiveRoutingEnabled());
    })();
  }, []);

  const toggleDeepResearch = async (value: boolean) => {
    setDeepResearchState(value);
    await setDeepResearchMode(value);
  };

  const toggleAdaptiveRouting = async (value: boolean) => {
    setAdaptiveRoutingState(value);
    await setAdaptiveRoutingEnabled(value);
  };

  const selectPersonality = async (id: PersonalityId) => {
    setPersonalityIdState(id);
    await setPersonalityId(id);
  };

  const updateCustomPrompt = async (text: string) => {
    setCustomPromptState(text);
    await setCustomSystemPrompt(text);
  };

  const selectMaxTokens = async (n: number | undefined) => {
    setMaxTokensState(n);
    await setMaxTokens(n);
  };

  return (
    <>
    <View style={styles.card}>
      <Text style={styles.title}>{t("personalitySettings.title")}</Text>

      {offeredStyles(personalityId).map((p) => (
        <Pressable
          key={p.id}
          style={[styles.option, personalityId === p.id && styles.optionSelected]}
          onPress={() => selectPersonality(p.id)}
        >
          <View style={styles.radio}>
            {personalityId === p.id && <View style={styles.radioDot} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.optionLabel}>
              {p.icon} {t(`personalities.${p.id}.label`)}
            </Text>
            <Text style={styles.optionDescription}>{t(`personalities.${p.id}.description`)}</Text>
          </View>
        </Pressable>
      ))}

      {personalityId === "custom" && (
        <TextInput
          style={styles.customInput}
          value={customPrompt}
          onChangeText={updateCustomPrompt}
          placeholder={t("personalitySettings.customPromptPlaceholder")}
          placeholderTextColor={colors.text.dim}
          multiline
        />
      )}

      <Text style={styles.subheading}>{t("personalitySettings.maxOutputTokens")}</Text>
      <View style={styles.tokenRow}>
        {[undefined, ...MAX_TOKENS_OPTIONS].map((n) => (
          <Pressable
            key={n ?? "auto"}
            style={[styles.tokenPill, maxTokens === n && styles.tokenPillSelected]}
            onPress={() => selectMaxTokens(n)}
          >
            <Text style={[styles.tokenPillText, maxTokens === n && styles.tokenPillTextSelected]}>
              {n ?? t("personalitySettings.maxTokensAuto", { n: autoMaxTokens(personalityId, deepResearch) })}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.note}>{t("personalitySettings.maxOutputTokensNote")}</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.deepResearchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>🔬 {t("personalitySettings.deepResearchTitle")}</Text>
            <Text style={styles.note}>{t("personalitySettings.deepResearchNote")}</Text>
          </View>
          <Switch
            value={deepResearch}
            onValueChange={toggleDeepResearch}
            trackColor={{ false: colors.border.default, true: colors.emerald[500] }}
          />
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.deepResearchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>🧭 {t("personalitySettings.adaptiveRoutingTitle")}</Text>
            <Text style={styles.note}>{t("personalitySettings.adaptiveRoutingNote")}</Text>
          </View>
          <Switch
            value={adaptiveRouting}
            onValueChange={toggleAdaptiveRouting}
            trackColor={{ false: colors.border.default, true: colors.emerald[500] }}
          />
        </View>
    </View>
    </>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg.card, borderRadius: 10, padding: 14, margin: 12, gap: 10 },
  deepResearchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { color: colors.text.heading, fontSize: 14, fontWeight: "600" },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    borderRadius: 8,
  },
  optionSelected: { backgroundColor: colors.emerald.bgSubtle },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.border.elevated,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.emerald[500] },
  optionLabel: { color: colors.text.primary, fontSize: 13, fontWeight: "600" },
  optionDescription: { color: colors.text.muted, fontSize: 11, marginTop: 2 },
  customInput: {
    backgroundColor: colors.bg.cardHover,
    color: colors.text.heading,
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    minHeight: 70,
    textAlignVertical: "top",
  },
  subheading: { color: colors.text.secondary, fontSize: 12, fontWeight: "600", marginTop: 4 },
  tokenRow: { flexDirection: "row", gap: 8 },
  tokenPill: {
    backgroundColor: colors.bg.cardHover,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  tokenPillSelected: { backgroundColor: colors.emerald[600] },
  tokenPillText: { color: colors.text.muted, fontSize: 12 },
  tokenPillTextSelected: { color: colors.text.heading, fontWeight: "600" },
  note: { color: colors.text.dim, fontSize: 11 },
});
