/**
 * The boar mascot, reacting to what the app is doing: it sways while searching the sources, tilts its
 * head while thinking, bobs while answering or reading aloud, perks up while listening and looks down
 * when nothing was found. Art per growth stage comes from art.ts; motion is here. Respects the system's
 * reduce-motion setting.
 */
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Image, Platform, StyleSheet, View } from "react-native";
import { colors } from "../theme/colors";
import { artFor } from "./art";
import type { GrowthStage } from "./growth";
import type { Mood } from "./mood";

const NATIVE = Platform.OS !== "web";

interface Props {
  stage: GrowthStage;
  mood: Mood;
  size: number;
  accessibilityLabel?: string;
}

function loop(value: Animated.Value, ms: number): Animated.CompositeAnimation {
  return Animated.loop(
    Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: ms / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: NATIVE }),
      Animated.timing(value, { toValue: 0, duration: ms / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: NATIVE }),
    ])
  );
}

/** Period of the mood's loop, ms. */
const PERIOD: Record<Mood, number> = {
  idle: 3200,
  listening: 1000,
  searching: 900,
  thinking: 1400,
  answering: 700,
  speaking: 450,
  notfound: 4000,
};

export function BoarBuddy({ stage, mood, size, accessibilityLabel }: Props) {
  const t = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.().then(setReduceMotion).catch(() => {});
  }, []);

  useEffect(() => {
    t.setValue(0);
    if (reduceMotion) return;
    const anim = loop(t, PERIOD[mood]);
    anim.start();
    return () => anim.stop();
  }, [mood, reduceMotion, t]);

  const unit = size / 100;
  const transform = (() => {
    switch (mood) {
      case "idle":
        return [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] }) }];
      case "listening":
        return [{ rotate: "-6deg" }, { scale: t.interpolate({ inputRange: [0, 1], outputRange: [1.02, 1.06] }) }];
      case "searching":
        return [
          { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [-4 * unit, 4 * unit] }) },
          { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ["-3deg", "3deg"] }) },
        ];
      case "thinking":
        return [{ rotate: "5deg" }, { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -1.5 * unit] }) }];
      case "answering":
      case "speaking":
        return [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -3 * unit] }) }];
      case "notfound":
        return [{ rotate: "-9deg" }, { translateY: 3 * unit }];
    }
  })();

  const dot = Math.max(3, Math.round(size / 14));
  return (
    <View style={{ width: size, height: size }} accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      {mood === "listening" && (
        <Animated.View
          style={[
            styles.ring,
            { borderRadius: size / 2, opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.45] }) },
          ]}
        />
      )}
      <Animated.View style={{ flex: 1, transform, opacity: mood === "notfound" ? 0.85 : 1 }}>
        <Image source={artFor(stage, mood)} style={{ width: size, height: size }} resizeMode="contain" />
      </Animated.View>
      {mood === "thinking" && (
        <View style={[styles.dots, { gap: dot / 2 }]}>
          {[0, 1, 2].map((i) => (
            <Animated.View
              key={i}
              style={{
                width: dot,
                height: dot,
                borderRadius: dot / 2,
                backgroundColor: colors.text.accentAmber,
                opacity: t.interpolate({ inputRange: [0, 1], outputRange: i % 2 ? [1, 0.3] : [0.3, 1] }),
              }}
            />
          ))}
        </View>
      )}
      {mood === "speaking" && (
        <View style={[styles.bars, { gap: dot / 2, height: size * 0.3 }]}>
          {[0, 1, 2].map((i) => (
            <Animated.View
              key={i}
              style={{
                width: dot * 0.8,
                borderRadius: dot,
                backgroundColor: colors.text.accentAmber,
                height: size * 0.28,
                // scaleY, not height: the native driver can't animate layout props.
                transform: [{ scaleY: t.interpolate({ inputRange: [0, 1], outputRange: i === 1 ? [1, 0.35] : [0.35, 1] }) }],
              }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderWidth: 2, borderColor: colors.text.accentAmber },
  dots: { position: "absolute", top: 0, right: 0, flexDirection: "row" },
  bars: { position: "absolute", left: 0, bottom: "18%", flexDirection: "row", alignItems: "flex-end" },
});
