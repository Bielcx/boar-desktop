import React, { useEffect, useState } from "react";
import { View, StyleSheet, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { colors } from "./theme/colors";
import { Text, TextInput } from "./components/AppText";
import { changePin, disablePin, enablePin, pinStatus, validPin } from "../services/pinLock";

type Mode = "idle" | "change" | "remove";

/**
 * Settings › Security (desktop only; ModelSetupScreen hides the section when pinLockAvailable() is false): a PIN that
 * opens BOAR and seals the chats on disk. Set, change or remove it.
 */
export function SecuritySettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ isSet: boolean; available: boolean } | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [c, setC] = useState("");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => pinStatus().then(setStatus);
  useEffect(() => {
    refresh();
  }, []);

  const reset = (m: Mode = "idle") => {
    setMode(m);
    setA("");
    setB("");
    setC("");
  };

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const err = await fn();
      if (err) setMessage({ text: err, ok: false });
    } catch (e: any) {
      setMessage({ text: e?.message ?? String(e), ok: false });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  // Set: the new PIN twice. Change: current, new, new again. Remove: current.
  const setPin = () =>
    run(async () => {
      if (!validPin(a)) return t("pinLock.invalid");
      if (a !== b) return t("pinLock.mismatch");
      await enablePin(a);
      reset();
      setMessage({ text: t("pinLock.setDone"), ok: true });
      return null;
    });
  const change = () =>
    run(async () => {
      if (!validPin(b)) return t("pinLock.invalid");
      if (b !== c) return t("pinLock.mismatch");
      if (!(await changePin(a, b))) return t("pinLock.wrong");
      reset();
      setMessage({ text: t("pinLock.changeDone"), ok: true });
      return null;
    });
  const remove = () =>
    run(async () => {
      const r = await disablePin(a);
      if (!r.ok) return r.waitSeconds > 0 ? t("pinLock.wait", { seconds: r.waitSeconds }) : t("pinLock.wrong");
      reset();
      setMessage({ text: t("pinLock.removeDone"), ok: true });
      return null;
    });

  if (!status) return null;

  const field = (value: string, set: (v: string) => void, label: string) => (
    <TextInput
      style={styles.input}
      value={value}
      onChangeText={(v) => set(v.replace(/\D/g, "").slice(0, 8))}
      secureTextEntry
      keyboardType="number-pad"
      placeholder={label}
      placeholderTextColor={colors.text.dim}
      accessibilityLabel={label}
    />
  );

  return (
    <View style={styles.card}>
      <Text style={styles.note}>{t("pinLock.hint")}</Text>
      <Text style={styles.rowLabel}>{status.isSet ? t("pinLock.statusOn") : t("pinLock.statusOff")}</Text>

      {!status.available && !status.isSet && <Text style={styles.error}>{t("pinLock.unavailable")}</Text>}

      {!status.isSet && status.available && (
        <>
          {field(a, setA, t("pinLock.newPin"))}
          {field(b, setB, t("pinLock.repeatPin"))}
          <Pressable style={[styles.button, busy && styles.disabled]} onPress={setPin} disabled={busy}>
            <Text style={styles.buttonText}>{busy ? t("pinLock.sealing") : t("pinLock.setPin")}</Text>
          </Pressable>
        </>
      )}

      {status.isSet && mode === "idle" && (
        <View style={styles.row}>
          <Pressable style={[styles.button, styles.secondary]} onPress={() => reset("change")}>
            <Text style={styles.buttonText}>{t("pinLock.changePin")}</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.secondary]} onPress={() => reset("remove")}>
            <Text style={styles.buttonText}>{t("pinLock.removePin")}</Text>
          </Pressable>
        </View>
      )}

      {status.isSet && mode === "change" && (
        <>
          {field(a, setA, t("pinLock.currentPin"))}
          {field(b, setB, t("pinLock.newPin"))}
          {field(c, setC, t("pinLock.repeatPin"))}
          <View style={styles.row}>
            <Pressable style={[styles.button, busy && styles.disabled]} onPress={change} disabled={busy}>
              <Text style={styles.buttonText}>{t("pinLock.changePin")}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.secondary]} onPress={() => reset()}>
              <Text style={styles.buttonText}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        </>
      )}

      {status.isSet && mode === "remove" && (
        <>
          <Text style={styles.note}>{t("pinLock.removeNote")}</Text>
          {field(a, setA, t("pinLock.currentPin"))}
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.danger, busy && styles.disabled]} onPress={remove} disabled={busy}>
              <Text style={styles.buttonText}>{t("pinLock.removePin")}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.secondary]} onPress={() => reset()}>
              <Text style={styles.buttonText}>{t("common.cancel")}</Text>
            </Pressable>
          </View>
        </>
      )}

      {message && <Text style={message.ok ? styles.ok : styles.error}>{message.text}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg.card, borderRadius: 10, padding: 14, margin: 12, gap: 10 },
  row: { flexDirection: "row", gap: 8 },
  rowLabel: { color: colors.text.primary, fontSize: 13, fontWeight: "600" },
  note: { color: colors.text.dim, fontSize: 11, lineHeight: 16 },
  input: {
    backgroundColor: colors.bg.cardHover,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.text.primary,
    fontSize: 14,
    letterSpacing: 4,
  },
  button: { flex: 1, backgroundColor: colors.emerald[600], borderRadius: 6, paddingVertical: 10, alignItems: "center" },
  buttonText: { color: colors.text.heading, fontSize: 13, fontWeight: "600" },
  secondary: { backgroundColor: colors.bg.cardHover },
  danger: { backgroundColor: colors.crimson[600] },
  disabled: { opacity: 0.5 },
  ok: { color: colors.text.accentEmerald, fontSize: 12 },
  error: { color: colors.crimson[400], fontSize: 12 },
});
