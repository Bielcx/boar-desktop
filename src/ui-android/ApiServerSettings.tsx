import React, { useEffect, useState } from "react";
import { View, StyleSheet, Switch, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { colors } from "./theme/colors";
import { Text, TextInput } from "./components/AppText";
import { apiServer, type ApiServerStatus } from "../services/apiServer";

const EXPIRY = [null, 30, 90, 365] as const;

/**
 * Settings › Local API server (desktop only; ModelSetupScreen hides it when apiServerAvailable() is false): on/off,
 * the port, and the tokens other programs use. A new token is shown once.
 */
export function ApiServerSettings() {
  const { t } = useTranslation();
  const [state, setState] = useState<ApiServerStatus | null>(null);
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [days, setDays] = useState<(typeof EXPIRY)[number]>(90);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const show = (s: ApiServerStatus) => {
    setState(s);
    setPort(String(s.port));
  };
  useEffect(() => {
    apiServer?.get().then(show);
  }, []);

  if (!apiServer || !state) return null;
  const api = apiServer;
  const base = `http://127.0.0.1:${state.port}`;
  const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "—");

  const create = async () => {
    const { token, info } = await api.createToken(name.trim() || t("apiServer.defaultName"), days);
    setFresh({ name: info.name, token });
    setCopied(false);
    setName("");
    show(await api.get());
  };
  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
  };

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>{t("apiServer.enable")}</Text>
          <Text style={styles.rowValue}>{t("apiServer.enableNote")}</Text>
        </View>
        <Switch
          value={state.enabled}
          onValueChange={(v) => api.set({ enabled: v, port: Number(port) || state.port }).then(show)}
          trackColor={{ false: colors.border.default, true: colors.emerald[500] }}
          accessibilityLabel={t("apiServer.enable")}
        />
      </View>

      <View style={styles.row}>
        <Text style={[styles.rowLabel, { flex: 1 }]}>{t("apiServer.port")}</Text>
        <TextInput
          style={[styles.input, styles.portInput]}
          value={port}
          onChangeText={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))}
          onBlur={() => Number(port) !== state.port && api.set({ enabled: state.enabled, port: Number(port) }).then(show)}
          keyboardType="number-pad"
          accessibilityLabel={t("apiServer.port")}
        />
      </View>

      <Text style={state.error ? styles.error : styles.rowValue}>
        {state.error ?? (state.running ? t("apiServer.running", { url: base }) : t("apiServer.stopped"))}
      </Text>

      <Text style={styles.heading}>{t("apiServer.tokens")}</Text>
      {state.tokens.length === 0 && <Text style={styles.rowValue}>{t("apiServer.noTokens")}</Text>}
      {state.tokens.map((tk) => (
        <View key={tk.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>{tk.name}</Text>
            <Text style={styles.rowValue}>
              {tk.hint} · {t("apiServer.lastUsed", { date: date(tk.lastUsedAt) })} ·{" "}
              {tk.expiresAt ? t("apiServer.expires", { date: date(tk.expiresAt) }) : t("apiServer.neverExpires")}
            </Text>
          </View>
          <Pressable onPress={() => api.revokeToken(tk.id).then(show)} hitSlop={8} accessibilityLabel={t("apiServer.revoke")}>
            <Text style={styles.danger}>{t("apiServer.revoke")}</Text>
          </Pressable>
        </View>
      ))}

      {fresh && (
        <View style={styles.fresh}>
          <Text style={styles.rowLabel}>{t("apiServer.copyNow", { name: fresh.name })}</Text>
          <Text selectable style={styles.token}>{fresh.token}</Text>
          <Pressable style={styles.button} onPress={() => copy(fresh.token)}>
            <Text style={styles.buttonText}>{copied ? t("apiServer.copied") : t("apiServer.copy")}</Text>
          </Pressable>
        </View>
      )}

      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder={t("apiServer.namePlaceholder")}
        placeholderTextColor={colors.text.dim}
        accessibilityLabel={t("apiServer.namePlaceholder")}
      />
      <View style={styles.chips}>
        {EXPIRY.map((d) => (
          <Pressable key={String(d)} onPress={() => setDays(d)} style={[styles.chip, days === d && styles.chipOn]}>
            <Text style={[styles.chipText, days === d && styles.chipTextOn]}>{d === null ? t("apiServer.never") : t("apiServer.days", { count: d })}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable style={styles.button} onPress={create}>
        <Text style={styles.buttonText}>＋ {t("apiServer.create")}</Text>
      </Pressable>

      <Text style={styles.heading}>{t("apiServer.example")}</Text>
      <Text selectable style={styles.code}>
        {`curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"messages":[{"role":"user","content":"What is a black hole?"}]}'`}
      </Text>
      <Text style={styles.note}>{t("apiServer.routes")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg.card, borderRadius: 10, padding: 14, margin: 12, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowLabel: { color: colors.text.primary, fontSize: 13, fontWeight: "600" },
  rowValue: { color: colors.text.muted, fontSize: 12, marginTop: 2 },
  heading: { color: colors.text.heading, fontSize: 13, fontWeight: "700", marginTop: 6 },
  note: { color: colors.text.dim, fontSize: 11, lineHeight: 16 },
  error: { color: colors.crimson[400], fontSize: 12 },
  danger: { color: colors.crimson[400], fontSize: 12, fontWeight: "600" },
  input: { backgroundColor: colors.bg.cardHover, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, color: colors.text.primary, fontSize: 13 },
  portInput: { width: 90, textAlign: "center" },
  fresh: { borderWidth: 1, borderColor: colors.emerald.border, backgroundColor: colors.emerald.bgSubtle, borderRadius: 8, padding: 10, gap: 8 },
  token: { color: colors.text.primary, fontSize: 12, fontFamily: "monospace" },
  code: { color: colors.text.muted, fontSize: 11, fontFamily: "monospace", backgroundColor: colors.bg.cardHover, borderRadius: 6, padding: 10 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 10, paddingVertical: 4 },
  chipOn: { backgroundColor: colors.emerald.bgSubtle, borderColor: colors.emerald.border },
  chipText: { color: colors.text.muted, fontSize: 11 },
  chipTextOn: { color: colors.text.accentEmerald, fontWeight: "600" },
  button: { backgroundColor: colors.emerald[600], borderRadius: 6, paddingVertical: 10, alignItems: "center" },
  buttonText: { color: colors.text.heading, fontSize: 13, fontWeight: "600" },
});
