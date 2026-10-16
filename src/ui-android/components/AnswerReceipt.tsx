import React from "react";
import { View, StyleSheet, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "./AppText";
import { colors } from "../theme/colors";
import { typography } from "../theme/typography";
import { approxWords, formatSeconds, type Receipt } from "./receipt";

/**
 * In the answer's footer, between the rating and the copy button: time and speed for everyone, tapped open for the
 * details only with Show technical details on (canOpen).
 */
export function ReceiptToggle({ receipt, open, onToggle, canOpen = true }: { receipt: Receipt; open: boolean; onToggle: () => void; canOpen?: boolean }) {
  const { t } = useTranslation();
  if (!canOpen) {
    return (
      <Text style={styles.short}>
        {formatSeconds(receipt.totalMs)} · {t("chat.receipt.speed", { rate: receipt.tokPerSec.toFixed(1) })}
      </Text>
    );
  }
  return (
    <Pressable onPress={onToggle} hitSlop={6} accessibilityLabel={t("chat.receipt.details")}>
      <Text style={styles.short}>
        {formatSeconds(receipt.totalMs)} · {t("chat.receipt.speed", { rate: receipt.tokPerSec.toFixed(1) })} {open ? "▴" : "▾"}
      </Text>
    </Pressable>
  );
}

/** What the answer took, step by step (main's receiptDetails). */
export function ReceiptDetails({ receipt }: { receipt: Receipt }) {
  const { t } = useTranslation();
  const count = (tokens: number) => t("chat.receipt.tokenCount", { tokens, words: approxWords(tokens) });
  const rows: [string, string][] = [
    [t("chat.receipt.start"), formatSeconds(receipt.ttftMs)],
    ...(receipt.model ? [[t("chat.receipt.model"), receipt.model] as [string, string]] : []),
    [t("chat.receipt.speedLabel"), t("chat.receipt.speedBoth", { rate: receipt.tokPerSec.toFixed(1), words: approxWords(receipt.tokPerSec) })],
    [t("chat.receipt.words"), count(receipt.tokens)],
    [t("chat.receipt.total"), formatSeconds(receipt.totalMs)],
  ];
  return (
    <View style={styles.details}>
      {rows.map(([label, value]) => (
        <Text key={label} style={styles.row}>
          {label}: <Text style={styles.value}>{value}</Text>
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  short: { ...typography.ui.micro, fontSize: 11, color: colors.text.dim },
  details: { marginTop: 6, gap: 2 },
  row: { ...typography.ui.micro, fontSize: 11, color: colors.text.dim },
  value: { color: colors.text.muted },
});
