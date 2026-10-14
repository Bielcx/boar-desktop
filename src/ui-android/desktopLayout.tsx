import React from "react";
import { Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { useTheme } from "./theme";

/**
 * Desktop (react-native-web in the Electron app) in a wide window: the drawer becomes a fixed sidebar and text
 * sits in a reading column instead of stretching edge to edge. Always false on Android, so its layout is unchanged.
 */
export const WIDE_MIN_WIDTH = 1000;
export const READING_WIDTH = 860;

export function useWideLayout(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= WIDE_MIN_WIDTH;
}

/** A full-screen page (Settings, About...) centred at reading width on a wide desktop window; as is otherwise. */
export function DesktopColumn({ children }: { children: React.ReactNode }) {
  const wide = useWideLayout();
  const { colors } = useTheme();
  if (!wide) return <>{children}</>;
  return (
    <View style={[styles.outer, { backgroundColor: colors.bg.terminal }]}>
      <View style={[styles.inner, { borderColor: colors.border.subtle }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, alignItems: "center" },
  inner: { flex: 1, width: "100%", maxWidth: READING_WIDTH + 120, borderLeftWidth: 1, borderRightWidth: 1 },
});
