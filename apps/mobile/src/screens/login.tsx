import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useApp } from "../app-state";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { Button, Muted } from "../ui";

export function LoginScreen() {
  const theme = useTheme();
  const { t, locale, choose } = useI18n();
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    setError("");
    try {
      await app.signInFlow();
    } catch (caught) {
      setError(app.describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.brand}>
          <View style={styles.mark}>
            <Text style={styles.markText}>KK</Text>
          </View>
          <Text style={[styles.wordmark, { color: theme.ink }]}>KKChat</Text>
        </View>
        <Text style={[styles.tagline, { color: theme.ink }]}>{t("tagline")}</Text>
        <Muted>{t("signInHint")}</Muted>
        <View style={styles.actions}>
          <Button label={t("signIn")} onPress={() => void start()} busy={busy} accessibilityLabel={t("signIn")} />
          {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
        </View>
        <View style={styles.lang}>
          <Button label="简体中文" kind={locale === "zh" ? "primary" : "ghost"} onPress={() => choose("zh")} style={styles.langButton} />
          <Button label="English" kind={locale === "en" ? "primary" : "ghost"} onPress={() => choose("en")} style={styles.langButton} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "center", padding: 28, gap: 16, maxWidth: 520, width: "100%", alignSelf: "center" },
  brand: { flexDirection: "row", alignItems: "center", gap: 12 },
  mark: { width: 52, height: 52, borderRadius: 16, backgroundColor: "#1e3a5f", alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#c2410c" },
  markText: { color: "white", fontWeight: "800", fontSize: 20 },
  wordmark: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  tagline: { fontSize: 26, fontWeight: "700", lineHeight: 34 },
  actions: { gap: 10, marginTop: 8 },
  error: { fontSize: 14, lineHeight: 20 },
  lang: { flexDirection: "row", gap: 10, marginTop: 12 },
  langButton: { flex: 1 },
});
