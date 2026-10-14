/**
 * The empty chat, after the new UI: the boar, the name and a tagline, then a few short questions to
 * start with (chat/suggestions.ts picks the ones checked for this model and language). Tap sends;
 * long-press puts the question in the input box to edit.
 */
import React from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "./AppText";
import { colors } from "../theme/colors";
import { typography } from "../theme/typography";
import { spacing } from "../theme/spacing";

interface Props {
  /** Keys (q2, q8…) from suggestionsFor. */
  suggestions: string[];
  onAsk: (question: string) => void;
  onFill: (question: string) => void;
  /** Replaces the static mascot image (the animated BoarBuddy). */
  mascot?: React.ReactNode;
  /** Under the tagline, e.g. "Young boar · 2 packs to grow". */
  growthLabel?: string;
  /** The conversation's agent profile name, in place of BOAR. */
  title?: string;
  /** The user's agent profiles, to start this conversation with one. */
  profiles?: Array<{ id: string; name: string }>;
  onPickProfile?: (id: string) => void;
}

export function ChatEmptyState({ suggestions, onAsk, onFill, mascot, growthLabel, title, profiles = [], onPickProfile }: Props) {
  const { t } = useTranslation();
  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        {mascot ?? <Image source={require("../../../assets/mascot.png")} style={styles.mascot} resizeMode="contain" />}
        <Text style={styles.wordmark}>{title ?? "BOAR"}</Text>
        <Text style={styles.tagline}>{t("chat.empty.tagline")}</Text>
        {growthLabel ? <Text style={styles.growth}>{growthLabel}</Text> : null}
      </View>
      {profiles.length > 0 && onPickProfile && (
        <View style={styles.profiles}>
          <Text style={styles.label}>{t("profiles.talkWith")}</Text>
          <View style={styles.profileChips}>
            {profiles.map((p) => (
              <Pressable key={p.id} onPress={() => onPickProfile(p.id)} style={styles.profileChip} accessibilityRole="button">
                <Text style={styles.profileChipText}>🐗 {p.name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {suggestions.length > 0 && (
        <View style={styles.list}>
          <Text style={styles.label}>{t("chat.empty.suggestionsLabel")}</Text>
          {suggestions.map((k) => {
            const q = t(`chat.suggestions.${k}`);
            return (
              <Pressable
                key={k}
                style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                onPress={() => onAsk(q)}
                onLongPress={() => onFill(q)}
                accessibilityRole="button"
                accessibilityLabel={t("chat.empty.ask", { question: q })}
                accessibilityHint={t("chat.empty.fill")}
              >
                <Text style={styles.topic}>{t(`chat.suggestionTopics.${k}`)}</Text>
                <Text style={styles.question}>{q}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  profiles: { gap: 6, alignItems: "center" },
  profileChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
  profileChip: { borderRadius: 999, borderWidth: 1, borderColor: colors.emerald.border, backgroundColor: colors.emerald.bgSubtle, paddingHorizontal: 12, paddingVertical: 6 },
  profileChipText: { color: colors.text.accentEmerald, fontSize: 13, fontWeight: "600" },
  container: { flexGrow: 1, gap: spacing.md, paddingTop: spacing.lg },
  hero: { alignItems: "center", gap: 6, paddingBottom: spacing.sm },
  mascot: { width: 96, height: 96 },
  wordmark: { ...typography.ui.headline, color: colors.text.heading },
  tagline: { ...typography.ui.subtext, fontWeight: "500", color: colors.text.accentEmerald, textAlign: "center" },
  growth: { ...typography.ui.caption, color: colors.text.secondary, textAlign: "center" },
  list: { gap: spacing.sm },
  label: { ...typography.ui.caption, color: colors.text.secondary, paddingHorizontal: spacing.xs },
  // Flat cards, told apart from the background by a lighter fill, as in the new UI.
  card: { backgroundColor: colors.bg.card, borderRadius: 18, paddingHorizontal: spacing.base, paddingVertical: spacing.md, gap: 4 },
  cardPressed: { backgroundColor: colors.bg.cardHover },
  topic: { ...typography.ui.caption, fontWeight: "600", color: colors.text.accentEmerald },
  question: { ...typography.ui.body, color: colors.text.primary },
});
