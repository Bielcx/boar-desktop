import { ThemeId } from "../../models/settings";

/**
 * BOAR Design System — Curated Themes
 * 1. Midnight Slate (Default: OLED Black + Emerald Status)
 * 2. Amber Phosphor (Night Field Operations / Vintage CRT Amber Glow)
 * 3. Matrix (Neon Phosphor-Green Hacker Terminal)
 */

export const midnightTheme = {
  id: "midnight" as ThemeId,
  name: "Ocean",
  icon: "🌊",
  description: "OLED dark mode with emerald telemetry",
  bg: {
    black: "#000000",
    terminal: "#080C14",
    surface: "#0B0F19",
    card: "#0F172A",
    cardElevated: "#131D31",
    cardHover: "#1E293B",
    input: "#0A0E17",
    subtle: "rgba(255, 255, 255, 0.03)",
    overlay: "rgba(2, 6, 23, 0.78)",
    modalOverlay: "rgba(0, 0, 0, 0.85)",
  },
  border: {
    subtle: "rgba(255, 255, 255, 0.07)",
    default: "#1E293B",
    elevated: "#334155",
    focus: "#06B6D4",
    emerald: "rgba(16, 185, 129, 0.35)",
    cyan: "rgba(6, 182, 212, 0.35)",
    amber: "rgba(245, 158, 11, 0.4)",
    danger: "rgba(239, 68, 68, 0.4)",
    frontier: "rgba(139, 92, 246, 0.45)",
  },
  text: {
    primary: "#FFFFFF",
    heading: "#F8FAFC",
    secondary: "#CBD5E1",
    muted: "#94A3B8",
    dim: "#64748B",
    inverse: "#020617",
    accentEmerald: "#34D399",
    accentCyan: "#38BDF8",
    accentAmber: "#FBBF24",
    accentViolet: "#C084FC",
  },
  emerald: {
    50: "#ECFDF5",
    400: "#34D399",
    500: "#10B981",
    600: "#059669",
    900: "#064E3B",
    bgSubtle: "rgba(16, 185, 129, 0.12)",
    border: "rgba(16, 185, 129, 0.28)",
  },
  cyan: {
    400: "#22D3EE",
    500: "#06B6D4",
    600: "#0891B2",
    bgSubtle: "rgba(6, 182, 212, 0.12)",
    border: "rgba(6, 182, 212, 0.3)",
  },
  frontier: {
    glow: "#8B5CF6",
    glowCyan: "#06B6D4",
    badgeBg: "rgba(139, 92, 246, 0.18)",
    badgeBorder: "rgba(139, 92, 246, 0.45)",
    text: "#C4B5FD",
    gradientStart: "#1E1138",
    gradientEnd: "#081E2C",
  },
  amber: {
    400: "#FBBF24",
    500: "#F59E0B",
    600: "#D97706",
    bgSubtle: "rgba(245, 158, 11, 0.12)",
    border: "rgba(245, 158, 11, 0.35)",
  },
  crimson: {
    400: "#F87171",
    500: "#EF4444",
    600: "#DC2626",
    900: "#7F1D1D",
    bgSubtle: "rgba(239, 68, 68, 0.12)",
    border: "rgba(239, 68, 68, 0.35)",
  },
};

export const amberTheme = {
  id: "amber" as ThemeId,
  name: "Amber",
  icon: "🐗",
  description: "Warm night-vision CRT with zero blue-light strain",
  bg: {
    black: "#050402",
    terminal: "#0C0A04",
    surface: "#141008",
    card: "#1D160A",
    cardElevated: "#281F0E",
    cardHover: "#352A14",
    input: "#0F0C06",
    subtle: "rgba(245, 158, 11, 0.04)",
    overlay: "rgba(12, 10, 4, 0.82)",
    modalOverlay: "rgba(0, 0, 0, 0.88)",
  },
  border: {
    subtle: "rgba(245, 158, 11, 0.12)",
    default: "#3D2E12",
    elevated: "#5A441B",
    focus: "#F59E0B",
    emerald: "rgba(245, 158, 11, 0.4)",
    cyan: "rgba(251, 191, 36, 0.4)",
    amber: "rgba(245, 158, 11, 0.5)",
    danger: "rgba(239, 68, 68, 0.45)",
    frontier: "rgba(217, 119, 6, 0.5)",
  },
  text: {
    primary: "#FFFBEB",
    heading: "#FEF3C7",
    secondary: "#FDE68A",
    muted: "#D97706",
    dim: "#92400E",
    inverse: "#141008",
    accentEmerald: "#FBBF24",
    accentCyan: "#F59E0B",
    accentAmber: "#F59E0B",
    accentViolet: "#FCD34D",
  },
  emerald: {
    50: "#FFFBEB",
    400: "#FBBF24",
    500: "#F59E0B",
    600: "#D97706",
    900: "#78350F",
    bgSubtle: "rgba(245, 158, 11, 0.14)",
    border: "rgba(245, 158, 11, 0.35)",
  },
  cyan: {
    400: "#FCD34D",
    500: "#FBBF24",
    600: "#F59E0B",
    bgSubtle: "rgba(251, 191, 36, 0.12)",
    border: "rgba(251, 191, 36, 0.3)",
  },
  frontier: {
    glow: "#F59E0B",
    glowCyan: "#FBBF24",
    badgeBg: "rgba(245, 158, 11, 0.2)",
    badgeBorder: "rgba(245, 158, 11, 0.5)",
    text: "#FEF3C7",
    gradientStart: "#281804",
    gradientEnd: "#120B02",
  },
  amber: {
    400: "#FCD34D",
    500: "#FBBF24",
    600: "#F59E0B",
    bgSubtle: "rgba(245, 158, 11, 0.16)",
    border: "rgba(245, 158, 11, 0.4)",
  },
  crimson: {
    400: "#F87171",
    500: "#EF4444",
    600: "#DC2626",
    900: "#7F1D1D",
    bgSubtle: "rgba(239, 68, 68, 0.14)",
    border: "rgba(239, 68, 68, 0.4)",
  },
};

export const frontierTheme = {
  id: "frontier" as ThemeId,
  name: "Matrix",
  icon: "🟢",
  description: "Neon phosphor-green hacker terminal — maximum contrast, zero blue light",
  bg: {
    black: "#000000",
    terminal: "#00110A",
    surface: "#001A0D",
    card: "#012613",
    cardElevated: "#023018",
    cardHover: "#034021",
    input: "#000D06",
    subtle: "rgba(0, 255, 127, 0.04)",
    overlay: "rgba(0, 15, 8, 0.82)",
    modalOverlay: "rgba(0, 0, 0, 0.88)",
  },
  border: {
    subtle: "rgba(0, 255, 127, 0.12)",
    default: "#0A4025",
    elevated: "#0F5C35",
    focus: "#00FF7F",
    emerald: "rgba(0, 255, 127, 0.4)",
    cyan: "rgba(57, 255, 158, 0.4)",
    amber: "rgba(255, 195, 0, 0.4)",
    danger: "rgba(239, 68, 68, 0.4)",
    frontier: "rgba(0, 255, 127, 0.45)",
  },
  text: {
    primary: "#E8FFF0",
    heading: "#F0FFF5",
    secondary: "#8CFFC4",
    muted: "#3ECF7A",
    dim: "#1F8C50",
    inverse: "#00110A",
    accentEmerald: "#00FF7F",
    accentCyan: "#39FF9E",
    accentAmber: "#FFD400",
    accentViolet: "#A8FFCB",
  },
  emerald: {
    50: "#E8FFF0",
    400: "#00FF7F",
    500: "#00E070",
    600: "#00B85C",
    900: "#003D1F",
    bgSubtle: "rgba(0, 255, 127, 0.14)",
    border: "rgba(0, 255, 127, 0.35)",
  },
  cyan: {
    400: "#39FF9E",
    500: "#00E68A",
    600: "#00B86E",
    bgSubtle: "rgba(0, 230, 138, 0.12)",
    border: "rgba(0, 230, 138, 0.3)",
  },
  frontier: {
    glow: "#00FF7F",
    glowCyan: "#39FF9E",
    badgeBg: "rgba(0, 255, 127, 0.2)",
    badgeBorder: "rgba(0, 255, 127, 0.5)",
    text: "#D6FFE8",
    gradientStart: "#012613",
    gradientEnd: "#00110A",
  },
  amber: {
    400: "#FFD400",
    500: "#FFC300",
    600: "#E0A800",
    bgSubtle: "rgba(255, 195, 0, 0.14)",
    border: "rgba(255, 195, 0, 0.4)",
  },
  crimson: {
    400: "#F87171",
    500: "#EF4444",
    600: "#DC2626",
    900: "#7F1D1D",
    bgSubtle: "rgba(239, 68, 68, 0.14)",
    border: "rgba(239, 68, 68, 0.35)",
  },
};


/**
 * Campfire and Moonlight: the look of the marketing and social posts (the "Fogueira & Luar"
 * palettes, dark). Same shape as the themes above, so every screen takes them without edits:
 * emerald is the action color (primary buttons), cyan the "verified" gold (sources, seals), amber
 * the warning and crimson the error. Values from the designer's palette; status colors are the
 * AA-adjusted ones.
 */
export const campfireTheme = {
  id: "campfire" as ThemeId,
  name: "Campfire",
  icon: "🔥",
  description: "Ember on warm charcoal",
  bg: {
    black: "#120D0A",
    terminal: "#17110D",
    surface: "#1C1510",
    card: "#221913",
    cardElevated: "#2A1F17",
    cardHover: "#33271E",
    input: "#1A130F",
    subtle: "rgba(245, 233, 220, 0.03)",
    overlay: "rgba(23, 17, 13, 0.78)",
    modalOverlay: "rgba(10, 7, 5, 0.85)",
  },
  border: {
    subtle: "rgba(245, 233, 220, 0.07)",
    default: "#4A3526",
    elevated: "#5C4432",
    focus: "#FF7A3D",
    emerald: "rgba(255, 122, 61, 0.35)",
    cyan: "rgba(255, 193, 94, 0.35)",
    amber: "rgba(242, 193, 78, 0.4)",
    danger: "rgba(242, 105, 81, 0.4)",
    frontier: "rgba(255, 193, 94, 0.45)",
  },
  text: {
    primary: "#F5E9DC",
    heading: "#FFF4E8",
    secondary: "#D8CABA",
    muted: "#B3A596",
    dim: "#8A7B6C",
    inverse: "#17110D",
    accentEmerald: "#FF7A3D",
    accentCyan: "#FFC15E",
    accentAmber: "#F2C14E",
    accentViolet: "#FFC15E",
  },
  emerald: {
    50: "#FFF1E8",
    400: "#FF915C",
    500: "#FF7A3D",
    600: "#E5652B",
    900: "#4A2414",
    bgSubtle: "rgba(255, 122, 61, 0.12)",
    border: "rgba(255, 122, 61, 0.28)",
  },
  cyan: {
    400: "#FFCF80",
    500: "#FFC15E",
    600: "#E0A23F",
    bgSubtle: "rgba(255, 193, 94, 0.12)",
    border: "rgba(255, 193, 94, 0.3)",
  },
  frontier: {
    glow: "#FF7A3D",
    glowCyan: "#FFC15E",
    badgeBg: "rgba(255, 193, 94, 0.18)",
    badgeBorder: "rgba(255, 193, 94, 0.45)",
    text: "#FFC15E",
    gradientStart: "#2A1A10",
    gradientEnd: "#17110D",
  },
  amber: {
    400: "#F2C14E",
    500: "#E0AE3A",
    600: "#C79524",
    bgSubtle: "rgba(242, 193, 78, 0.12)",
    border: "rgba(242, 193, 78, 0.35)",
  },
  crimson: {
    400: "#F26951",
    500: "#F0674F",
    600: "#D2513B",
    900: "#4D1C14",
    bgSubtle: "rgba(242, 105, 81, 0.12)",
    border: "rgba(242, 105, 81, 0.35)",
  },
};

export const moonlightTheme = {
  id: "moonlight" as ThemeId,
  name: "Moonlight",
  icon: "🌙",
  description: "Amber on night blue",
  bg: {
    black: "#0A0E24",
    terminal: "#0E1330",
    surface: "#131938",
    card: "#171D42",
    cardElevated: "#1E254E",
    cardHover: "#262E5C",
    input: "#121836",
    subtle: "rgba(255, 248, 230, 0.03)",
    overlay: "rgba(14, 19, 48, 0.78)",
    modalOverlay: "rgba(6, 9, 24, 0.85)",
  },
  border: {
    subtle: "rgba(255, 248, 230, 0.07)",
    default: "#323B6E",
    elevated: "#424C86",
    focus: "#FFB547",
    emerald: "rgba(255, 181, 71, 0.35)",
    cyan: "rgba(244, 231, 181, 0.35)",
    amber: "rgba(242, 193, 78, 0.4)",
    danger: "rgba(249, 111, 87, 0.4)",
    frontier: "rgba(244, 231, 181, 0.45)",
  },
  text: {
    primary: "#FFF8E6",
    heading: "#FFFCF2",
    secondary: "#D2D6EA",
    muted: "#A9B0D0",
    dim: "#7C84A8",
    inverse: "#0E1330",
    accentEmerald: "#FFB547",
    accentCyan: "#F4E7B5",
    accentAmber: "#F2C14E",
    accentViolet: "#F4E7B5",
  },
  emerald: {
    50: "#FFF6E6",
    400: "#FFC266",
    500: "#FFB547",
    600: "#E59C2E",
    900: "#4A3210",
    bgSubtle: "rgba(255, 181, 71, 0.12)",
    border: "rgba(255, 181, 71, 0.28)",
  },
  cyan: {
    400: "#F8EEC8",
    500: "#F4E7B5",
    600: "#D9CA92",
    bgSubtle: "rgba(244, 231, 181, 0.12)",
    border: "rgba(244, 231, 181, 0.3)",
  },
  frontier: {
    glow: "#FFB547",
    glowCyan: "#F4E7B5",
    badgeBg: "rgba(244, 231, 181, 0.18)",
    badgeBorder: "rgba(244, 231, 181, 0.45)",
    text: "#F4E7B5",
    gradientStart: "#171D42",
    gradientEnd: "#0E1330",
  },
  amber: {
    400: "#F2C14E",
    500: "#E0AE3A",
    600: "#C79524",
    bgSubtle: "rgba(242, 193, 78, 0.12)",
    border: "rgba(242, 193, 78, 0.35)",
  },
  crimson: {
    400: "#F96F57",
    500: "#F0674F",
    600: "#D2513B",
    900: "#4D1C14",
    bgSubtle: "rgba(249, 111, 87, 0.12)",
    border: "rgba(249, 111, 87, 0.35)",
  },
};

// The themes offered in the picker. Ocean, Amber and Matrix stay defined but hidden.
export const THEMES = [campfireTheme, moonlightTheme] as const;

export function getThemeColors(id: ThemeId = "campfire") {
  switch (id) {
    case "campfire":
      return campfireTheme;
    case "moonlight":
      return moonlightTheme;
    case "amber":
      return amberTheme;
    case "frontier":
      return frontierTheme;
    case "midnight":
    default:
      return midnightTheme;
  }
}

// The colors most screens read once, at start (StyleSheet.create): Campfire, the app's look.
export const colors = campfireTheme;
export type Colors = typeof midnightTheme;
