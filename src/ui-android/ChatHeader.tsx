import React from "react";
import { View, Pressable, StyleSheet, Image, Alert } from "react-native";
import { useNetworkState } from "expo-network";
import { isOnline } from "../services/connectivity.pure";
import { Text } from "./components/AppText";
import { impact, ImpactFeedbackStyle } from "../services/haptics";
import { useTranslation } from "react-i18next";
import { colors } from "./theme/colors";
import { shortModelLabel } from "../models/modelLabel";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

interface Props {
  toneIcon: string;
  deepResearchActive: boolean;
  liveTokPerSec: number | null;
  activeModelLabel?: string;
  /** Opens the drawer; on a wide desktop window, hides or shows the fixed sidebar. */
  onOpenDrawer?: () => void;
  onCycleTone: () => void;
  onNewChat: () => void;
  onToggleDeepResearch?: () => void;
  /** Replaces the static mascot image (the animated BoarBuddy). */
  mascot?: React.ReactNode;
  /** The conversation's agent profile name, in place of BOAR. */
  title?: string;
}

/**
 * ChatHeader: Polished Field Terminal & Frontier AI top bar.
 * Showcases 🐗 BOAR mascot, offline local engine status,
 * dynamic frontier glow when Deep Research is engaged,
 * live tok/s telemetry, and quick-action controls.
 */
export function ChatHeader({
  toneIcon,
  deepResearchActive,
  liveTokPerSec,
  activeModelLabel,
  onOpenDrawer,
  onCycleTone,
  onNewChat,
  onToggleDeepResearch,
  mascot,
  title,
}: Props) {
  const { t } = useTranslation();
  // The phone's own state, live (no request is sent): ONLINE tells the user answers don't need it.
  const online = isOnline(useNetworkState());
  const explainConnection = () => {
    impact();
    Alert.alert(
      t(online ? "chatHeader.onlineTitle" : "chatHeader.offlineTitle"),
      t(online ? "chatHeader.onlineBody" : "chatHeader.offlineBody")
    );
  };
  const handlePress = (callback: () => void, feedback: ImpactFeedbackStyle = ImpactFeedbackStyle.Light) => {
    impact(feedback);
    callback();
  };

  return (
    <View
      style={[
        styles.headerContainer,
        deepResearchActive && styles.headerContainerDeepResearch,
      ]}
    >
      <View style={styles.topRow}>
        {/* Drawer Hamburger */}
        {onOpenDrawer && (
          <Pressable
            style={styles.iconBtn}
            onPress={() => handlePress(onOpenDrawer)}
            hitSlop={10}
            accessibilityLabel={t("chatHeader.openDrawer")}
          >
            <Text style={styles.hamburgerIcon}>☰</Text>
          </Pressable>
        )}

        {/* Brand & Mascot */}
        <View style={styles.brandContainer}>
          {mascot ?? (
            <Image
              source={require("../../assets/mascot.png")}
              style={styles.mascotImg}
              resizeMode="contain"
            />
          )}
          <View style={styles.titleColumn}>
            <View style={styles.titleRow}>
              <Text style={styles.titleText} numberOfLines={1} testID="chat-title">{title ?? "BOAR"}</Text>
              <Pressable
                style={[styles.offlineStatusPill, online && styles.onlineStatusPill]}
                onPress={explainConnection}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t(online ? "chatHeader.onlineTitle" : "chatHeader.offlineTitle")}
              >
                <View style={[styles.offlineDot, online && styles.onlineDot]} />
                <Text style={[styles.offlineText, online && styles.onlineText]}>
                  {t(online ? "chatHeader.online" : "chatHeader.offline")}
                </Text>
              </Pressable>
            </View>
            <Text style={styles.modelPillText} numberOfLines={1}>
              {activeModelLabel ? shortModelLabel(activeModelLabel).toUpperCase() : t("chatHeader.localLlmCore")}
            </Text>
          </View>
        </View>

        {/* Right Action Controls */}
        <View style={styles.rightActions}>
          {/* Tone Selector Pill */}
          <Pressable
            style={styles.tonePill}
            onPress={() => handlePress(onCycleTone)}
            hitSlop={6}
            accessibilityLabel={t("chatHeader.cycleTone")}
          >
            <Text style={styles.tonePillEmoji}>{toneIcon}</Text>
          </Pressable>

          {/* New Chat Button */}
          <Pressable
            style={styles.newChatBtn}
            onPress={() => handlePress(onNewChat, ImpactFeedbackStyle.Medium)}
            hitSlop={6}
            accessibilityLabel={t("chatHeader.newChatSession")}
          >
            <Text style={styles.newChatIcon}>+</Text>
          </Pressable>
        </View>
      </View>

      {/* Sub-bar: Telemetry & Deep Research Indicator / Toggle */}
      <View style={styles.subBar}>
        {onToggleDeepResearch ? (
          <Pressable
            style={[
              styles.deepResearchPill,
              deepResearchActive && styles.deepResearchPillActive,
            ]}
            onPress={() => handlePress(onToggleDeepResearch, ImpactFeedbackStyle.Medium)}
            hitSlop={6}
          >
            <Text style={styles.deepResearchIcon}>🔬</Text>
            <Text
              style={[
                styles.deepResearchText,
                deepResearchActive && styles.deepResearchTextActive,
              ]}
            >
              {t("chatHeader.deepResearch")}
            </Text>
            <View
              style={[
                styles.deepResearchStatusIndicator,
                deepResearchActive && styles.deepResearchStatusIndicatorActive,
              ]}
            />
          </Pressable>
        ) : deepResearchActive ? (
          <View style={[styles.deepResearchPill, styles.deepResearchPillActive]}>
            <Text style={styles.deepResearchIcon}>🔬</Text>
            <Text style={[styles.deepResearchText, styles.deepResearchTextActive]}>
              {t("chatHeader.deepResearchActive")}
            </Text>
          </View>
        ) : null}

        {/* Live Inference Telemetry Counter */}
        {liveTokPerSec != null && (
          <View style={styles.telemetryBadge}>
            <Text style={styles.telemetryPulseDot}>●</Text>
            <Text style={styles.telemetryText}>
              {liveTokPerSec.toFixed(1)} <Text style={styles.telemetryUnit}>tok/s</Text>
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    backgroundColor: colors.bg.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
    paddingHorizontal: spacing.md,
    paddingTop: 10,
    paddingBottom: 10,
    gap: 8,
  },
  headerContainerDeepResearch: {
    backgroundColor: "#111028",
    borderBottomColor: colors.border.frontier,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  // Round 42px controls and mascot, as in the new UI's header.
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  hamburgerIcon: {
    color: colors.text.heading,
    fontSize: 18,
    fontWeight: "700",
  },
  brandContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    marginLeft: 8,
  },
  mascotImg: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  titleColumn: {
    flex: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  titleText: {
    ...typography.ui.titleLg,
    color: colors.text.heading,
    letterSpacing: 0.5,
  },
  offlineStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald.border,
    borderWidth: 1,
    borderRadius: radii.xs,
    paddingHorizontal: 5,
    paddingVertical: 1,
    gap: 3,
  },
  onlineStatusPill: {
    backgroundColor: colors.amber.bgSubtle,
    borderColor: colors.amber.border,
  },
  onlineDot: { backgroundColor: colors.amber[400] },
  onlineText: { color: colors.text.accentAmber },
  offlineDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.emerald[400],
  },
  offlineText: {
    ...typography.mono.xs,
    fontSize: 8,
    fontWeight: "800",
    color: colors.text.accentEmerald,
  },
  modelPillText: {
    ...typography.mono.xs,
    color: colors.text.dim,
    marginTop: 1,
  },
  rightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  tonePill: {
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderColor: colors.border.subtle,
    borderWidth: 1,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  tonePillEmoji: {
    fontSize: 14,
  },
  newChatBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  newChatIcon: {
    color: colors.text.accentEmerald,
    fontSize: 18,
    fontWeight: "700",
    marginTop: -1,
  },
  subBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deepResearchPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderColor: colors.border.subtle,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 5,
  },
  deepResearchPillActive: {
    backgroundColor: colors.frontier.badgeBg,
    borderColor: colors.frontier.badgeBorder,
  },
  deepResearchIcon: {
    fontSize: 11,
  },
  deepResearchText: {
    ...typography.mono.xs,
    color: colors.text.muted,
    fontWeight: "600",
  },
  deepResearchTextActive: {
    color: colors.frontier.text,
    fontWeight: "700",
  },
  deepResearchStatusIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.text.dim,
  },
  deepResearchStatusIndicatorActive: {
    backgroundColor: colors.frontier.glow,
  },
  telemetryBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(6, 182, 212, 0.12)",
    borderColor: colors.cyan.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    gap: 5,
    marginLeft: "auto",
  },
  telemetryPulseDot: {
    color: colors.cyan[400],
    fontSize: 8,
  },
  telemetryText: {
    ...typography.mono.xs,
    color: colors.text.accentCyan,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  telemetryUnit: {
    color: colors.text.muted,
    fontWeight: "500",
  },
});
