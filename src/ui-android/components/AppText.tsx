/**
 * The app's Text and TextInput: React Native's, with the brand type applied to whatever style a
 * screen passes (theme/fonts.ts). The weight picks the Baloo 2 or Lexend file, fontWeight is dropped
 * (Android doesn't synthesize weights for custom fonts), monospace becomes Lexend with fixed-width
 * digits, and small sizes grow to the new scale. Screens import Text from here instead of
 * "react-native", and keep their styles as they are.
 */
import React, { createContext, forwardRef, useContext } from "react";
import { Platform, StyleSheet, Text as RNText, TextInput as RNTextInput, type TextInputProps, type TextProps, type TextStyle } from "react-native";
import { CODE, familyFor, fontScaleFactor, scaledLineHeight, scaledSize } from "../theme/fonts";
import { useTheme } from "../theme/ThemeContext";

/** Body size for text that sets none (the new scale's body). */
const BODY = 16;
const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

/** True inside a Text: a nested Text (bold or code inside a paragraph) inherits what it doesn't set. */
const InText = createContext(false);

/** Exported for tests: the style the brand type turns a screen's style into. */
/** `factor`: the Settings text size (fontScaleFactor). */
export function brandStyle(style: TextProps["style"], nested = false, factor = 1): TextStyle {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const { fontWeight, fontFamily, fontSize, lineHeight, fontVariant, ...rest } = flat;
  const out: TextStyle = { ...rest };
  // A nested Text with neither keeps its parent's face; anything else gets a bundled file.
  if (!nested || fontFamily !== undefined || fontWeight !== undefined) {
    const { family, tabular } = familyFor(fontFamily, fontWeight);
    out.fontFamily = family === CODE ? MONOSPACE : family;
    if (tabular || fontVariant) out.fontVariant = [...(fontVariant ?? []), ...(tabular ? (["tabular-nums"] as const) : [])];
  } else if (fontVariant) {
    out.fontVariant = fontVariant;
  }
  if (fontSize !== undefined) {
    out.fontSize = Math.round(scaledSize(fontSize) * factor);
    if (lineHeight !== undefined) out.lineHeight = scaledLineHeight(lineHeight, fontSize, out.fontSize);
  } else {
    if (!nested) out.fontSize = Math.round(BODY * factor);
    if (lineHeight !== undefined) out.lineHeight = Math.round(lineHeight * factor);
  }
  return out;
}

export const Text = forwardRef<RNText, TextProps>(function Text({ style, ...props }, ref) {
  const nested = useContext(InText);
  const factor = fontScaleFactor(useTheme().fontScale);
  const text = <RNText ref={ref} {...props} style={brandStyle(style, nested, factor)} />;
  return nested ? text : <InText.Provider value>{text}</InText.Provider>;
});

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  const factor = fontScaleFactor(useTheme().fontScale);
  return <RNTextInput ref={ref} {...props} style={brandStyle(style, false, factor)} />;
});

/** The instance types, for refs (useRef<TextInput>). */
export type Text = RNText;
export type TextInput = RNTextInput;
