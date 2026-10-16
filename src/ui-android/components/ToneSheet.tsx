import React from "react";
import { Modal, View, StyleSheet, Pressable, Switch } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "./AppText";
import { useTheme } from "../theme";
import { spacing, radii } from "../theme/spacing";
import { getPersonality, PersonalityId } from "../../constants/personalities";

interface Props {
  visible: boolean;
  /** The styles offered, in order (Custom only when it has a prompt). */
  tones: PersonalityId[];
  personalityId: PersonalityId;
  deepResearch: boolean;
  onSetTone: (id: PersonalityId) => void;
  onSetDeepResearch: (on: boolean) => void;
  onClose: () => void;
}

/**
 * The header's style button (the native app's ToneSheet): every answer style with what it does, the current one
 * marked, and Deep Research below (it runs in any style). Replaces cycling through the styles blind.
 */
export function ToneSheet({ visible, tones, personalityId, deepResearch, onSetTone, onSetDeepResearch, onClose }: Props) {
  const { t } = useTranslation();
  const { colors, typography } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t("common.cancel")}>
        {/* A press inside the card must not reach the backdrop. */}
        <Pressable style={[styles.card, { backgroundColor: colors.bg.surface, borderColor: colors.border.subtle }]} onPress={() => {}}>
          <Text style={[typography.ui.titleSm, { color: colors.text.heading }]}>{t("modelSetupScreen.sections.tone")}</Text>
          {tones.map((id) => {
            const selected = id === personalityId;
            return (
              <Pressable
                key={id}
                accessibilityRole="radio"
                aria-checked={selected}
                style={[
                  styles.row,
                  {
                    backgroundColor: selected ? colors.emerald.bgSubtle : colors.bg.card,
                    borderColor: selected ? colors.emerald.border : colors.border.subtle,
                  },
                ]}
                onPress={() => {
                  onSetTone(id);
                  onClose();
                }}
              >
                <Text style={styles.icon}>{getPersonality(id).icon}</Text>
                <View style={styles.texts}>
                  <Text style={[typography.ui.body, { color: selected ? colors.text.accentEmerald : colors.text.primary }]}>
                    {t(`personalities.${id}.label`)}
                  </Text>
                  <Text style={[typography.ui.caption, { color: colors.text.muted }]}>{t(`personalities.${id}.description`)}</Text>
                </View>
                {selected && <Text style={[styles.check, { color: colors.text.accentEmerald }]}>✓</Text>}
              </Pressable>
            );
          })}
          <View style={[styles.divider, { backgroundColor: colors.border.subtle }]} />
          <View style={styles.deepRow}>
            <Text style={styles.icon}>🔬</Text>
            <View style={styles.texts}>
              <Text style={[typography.ui.body, { color: colors.text.primary }]}>{t("personalitySettings.deepResearchTitle")}</Text>
              <Text style={[typography.ui.caption, { color: colors.text.muted }]}>{t("personalitySettings.deepResearchNote")}</Text>
            </View>
            <Switch
              value={deepResearch}
              onValueChange={onSetDeepResearch}
              trackColor={{ false: colors.border.subtle, true: colors.emerald[500] }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.6)", justifyContent: "center", alignItems: "center", padding: spacing.lg },
  card: { width: "100%", maxWidth: 520, borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  deepRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  icon: { fontSize: 20 },
  texts: { flex: 1, gap: 2 },
  check: { fontSize: 18 },
  divider: { height: 1, marginVertical: spacing.xs },
});
