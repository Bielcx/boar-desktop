import React, { useEffect, useState } from "react";
import { View, StyleSheet, Pressable, Image } from "react-native";
import { useTranslation } from "react-i18next";
import { colors } from "./theme/colors";
import { Text, TextInput } from "./components/AppText";
import { forgetPin, pinStatus, unlock } from "../services/pinLock";
import { MASCOT_ART } from "./mascot/art";

/**
 * BOAR is locked (desktop, with a PIN: src/services/pinLock.ts): the chats stay sealed until the PIN is entered.
 * "Forgot PIN" erases the chats, which can't be opened without it; documents and models stay.
 */
export function PinLockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [wait, setWait] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(() => {
    pinStatus().then((s) => setWait(s.waitSeconds));
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const submit = async () => {
    if (busy || wait > 0 || pin.length < 4) return;
    setBusy(true);
    try {
      const a = await unlock(pin);
      if (a.ok) return onUnlocked();
      setPin("");
      setError(t("pinLock.wrong"));
      setWait(a.waitSeconds);
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    await forgetPin();
    onUnlocked();
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Image source={MASCOT_ART.filhote.image} style={styles.mascot} />
        <Text style={styles.title}>{t("pinLock.lockedTitle")}</Text>
        <Text style={styles.note}>{t("pinLock.lockedNote")}</Text>
        <TextInput
          style={styles.input}
          value={pin}
          onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 8))}
          onSubmitEditing={submit}
          secureTextEntry
          keyboardType="number-pad"
          autoFocus
          editable={wait <= 0}
          placeholder={t("pinLock.pinPlaceholder")}
          placeholderTextColor={colors.text.dim}
          accessibilityLabel={t("pinLock.pinPlaceholder")}
        />
        {wait > 0 ? (
          <Text style={styles.error}>{t("pinLock.wait", { seconds: wait })}</Text>
        ) : (
          error && <Text style={styles.error}>{error}</Text>
        )}
        <Pressable style={[styles.button, (wait > 0 || pin.length < 4) && styles.disabled]} onPress={submit} disabled={busy || wait > 0}>
          <Text style={styles.buttonText}>{t("pinLock.unlock")}</Text>
        </Pressable>

        {!confirmForget ? (
          <Pressable onPress={() => setConfirmForget(true)} hitSlop={8}>
            <Text style={styles.link}>{t("pinLock.forgot")}</Text>
          </Pressable>
        ) : (
          <View style={styles.confirm}>
            <Text style={styles.note}>{t("pinLock.forgotWarning")}</Text>
            <View style={styles.row}>
              <Pressable style={[styles.button, styles.danger]} onPress={forget} disabled={busy}>
                <Text style={styles.buttonText}>{t("pinLock.forgotConfirm")}</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.secondary]} onPress={() => setConfirmForget(false)}>
                <Text style={styles.buttonText}>{t("common.cancel")}</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, backgroundColor: colors.bg.terminal },
  card: { width: "100%", maxWidth: 380, backgroundColor: colors.bg.card, borderRadius: 14, padding: 22, gap: 12, alignItems: "stretch" },
  mascot: { width: 96, height: 96, alignSelf: "center" },
  title: { color: colors.text.heading, fontSize: 18, fontWeight: "700", textAlign: "center" },
  note: { color: colors.text.muted, fontSize: 12, lineHeight: 17, textAlign: "center" },
  input: {
    backgroundColor: colors.bg.cardHover,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text.primary,
    fontSize: 20,
    letterSpacing: 6,
    textAlign: "center",
  },
  error: { color: colors.crimson[400], fontSize: 12, textAlign: "center" },
  button: { backgroundColor: colors.emerald[600], borderRadius: 8, paddingVertical: 11, alignItems: "center", flex: 1 },
  buttonText: { color: colors.text.heading, fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  danger: { backgroundColor: colors.crimson[600] },
  secondary: { backgroundColor: colors.bg.cardHover },
  link: { color: colors.text.dim, fontSize: 12, textAlign: "center", textDecorationLine: "underline" },
  confirm: { gap: 10 },
  row: { flexDirection: "row", gap: 8 },
});
