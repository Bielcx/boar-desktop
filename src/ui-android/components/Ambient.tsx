/**
 * The theme's light behind the chat, as in the new UI and the marketing posts: Campfire is an ember
 * glow rising from the bottom, Moonlight a faint moon at the top right. Decorative and static.
 * The glow uses React Native's CSS radial gradient; where that's unsupported it draws nothing.
 */
import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "../theme";

/** Peak alpha of the ember glow: text still clears AA contrast over it (the new UI's ambient.test). */
const EMBER_PEAK_ALPHA = 0.25;
const MOON_ALPHA = 0.13;
const MOON_SIZE = 110;

/** "#FF7A3D" -> "255, 122, 61" */
function rgb(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function emberGradient(glow: string): string {
  const mid = (EMBER_PEAK_ALPHA * 0.25).toFixed(3);
  return `radial-gradient(ellipse at 50% 100%, rgba(${glow}, ${EMBER_PEAK_ALPHA}) 0%, rgba(${glow}, ${mid}) 45%, rgba(${glow}, 0) 70%)`;
}

/** `top`: where the moon sits, below the header. */
export function Ambient({ top = 120 }: { top?: number }) {
  const { themeId, colors } = useTheme();
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      {themeId === "moonlight" ? (
        <View style={[styles.moon, { top, backgroundColor: colors.cyan[500] }]} />
      ) : (
        <View style={[styles.ember, { experimental_backgroundImage: emberGradient(rgb(colors.emerald[500])) } as ViewStyle]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  moon: {
    position: "absolute",
    right: -40,
    width: MOON_SIZE,
    height: MOON_SIZE,
    borderRadius: MOON_SIZE / 2,
    opacity: MOON_ALPHA,
  },
  ember: { position: "absolute", left: -60, right: -60, bottom: -170, height: 440 },
});
