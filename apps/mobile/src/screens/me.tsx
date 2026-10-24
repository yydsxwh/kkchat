import * as Notifications from "expo-notifications";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PrivacyView, PublicUser, ReportReason } from "@shared/types";
import { useApp } from "../app-state";
import { ACCOUNT_CENTER, APP_BUILD, APP_VERSION, PLATFORM, RELEASE_COMMIT, SUPPORT_URL } from "../config";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { readPrefs, writePrefs } from "../storage";
import { useTheme } from "../theme";
import { checkForUpdate, downloadAndInstall, UpdateError, type UpdateInfo } from "../update";
import { Avatar, Button, Empty, Field, Header, Muted, Row, Section, ToggleRow } from "../ui";

export function MeScreen() {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const nav = useNav();
  const [notifications, setNotifications] = useState(false);

  useEffect(() => {
    void readPrefs().then((prefs) => setNotifications(Boolean(prefs.notifications)));
  }, []);

  async function toggleNotifications(next: boolean) {
    if (next) {
      // 只在用户主动开启时申请通知权限。拒绝也不影响聊天。
      const result = await Notifications.requestPermissionsAsync();
      if (!result.granted) {
        app.flash(t("notificationsOff"));
        setNotifications(false);
        await writePrefs({ notifications: false });
        return;
      }
    }
    setNotifications(next);
    await writePrefs({ notifications: next });
  }

  const me = app.me;
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("tabMe")} />
      <ScrollView contentContainerStyle={styles.content}>
        {me ? (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.line }]}>
            <Avatar name={me.displayName} url={me.avatarUrl} size={64} />
            <Text style={[styles.name, { color: theme.ink }]}>{me.displayName}</Text>
            <Text style={[styles.kk, { color: theme.ink }]}>{me.kkNumber ?? "—"}</Text>
            <Muted>{`${t("kkNumber")} · ${me.username ? `@${me.username}` : t("noUsername")}`}</Muted>
            <Button label={t("myQr")} onPress={() => nav.push({ name: "myQr" })} style={styles.cardButton} />
          </View>
        ) : null}
        <Section title={t("switchAccount")}>
          {app.accounts.map((account) => (
            <Row
              key={account.accountSub}
              title={account.displayName}
              subtitle={account.kkNumber ? `${t("kkNumber")} ${account.kkNumber}` : undefined}
              left={<Avatar name={account.displayName} url={account.avatarUrl} size={36} />}
              right={account.accountSub === app.accountSub ? <Text style={{ color: theme.ok }}>✓</Text> : null}
              onPress={() => void app.switchAccount(account.accountSub).catch((error) => app.flash(app.describe(error)))}
            />
          ))}
          <Row title={t("addAccount")} onPress={() => void app.signInFlow({ prompt: "login" }).catch((error) => app.flash(app.describe(error)))} />
        </Section>
        <Section title={t("settings")}>
          <Row title={t("privacy")} onPress={() => nav.push({ name: "privacy" })} />
          <Row title={t("blockedList")} onPress={() => nav.push({ name: "blocks" })} />
          <Row title={t("language")} onPress={() => nav.push({ name: "language" })} />
          <ToggleRow label={t("notifications")} value={notifications} onChange={(value) => void toggleNotifications(value)} />
          <View style={styles.note}>
            <Muted>{notifications ? t("notificationsBackgroundNote") : t("notificationsOff")}</Muted>
          </View>
          <Row title={t("devices")} onPress={() => nav.push({ name: "devices" })} />
          <Row title={`${t("version")} ${APP_VERSION} (${APP_BUILD})`} subtitle={t("checkUpdate")} onPress={() => nav.push({ name: "about" })} />
          <Row title={t("help")} subtitle="www.yydsxwh.com/contact" onPress={() => void WebBrowser.openBrowserAsync(SUPPORT_URL)} />
          <Row
            title={t("deleteAccount")}
            subtitle={t("openAccountCenter")}
            onPress={() =>
              Alert.alert(t("deleteAccount"), t("deleteAccountBody"), [
                { text: t("cancel"), style: "cancel" },
                { text: t("openAccountCenter"), onPress: () => void WebBrowser.openBrowserAsync(`${ACCOUNT_CENTER}/account/security`) },
              ])
            }
          />
        </Section>
        <View style={styles.signOut}>
          <Button label={t("signOut")} kind="danger" onPress={() => void app.signOutCurrent()} />
        </View>
      </ScrollView>
    </View>
  );
}

export function PrivacyScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const [privacy, setPrivacy] = useState<PrivacyView | null>(null);
  useEffect(() => {
    void app.client?.privacy().then(setPrivacy).catch((error) => app.flash(app.describe(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const items: Array<{ key: keyof PrivacyView; label: Parameters<typeof t>[0] }> = [
    { key: "discoverByKkNumber", label: "discoverByKk" },
    { key: "discoverByUsername", label: "discoverByUsername" },
    { key: "discoverByName", label: "discoverByName" },
    { key: "allowFriendRequests", label: "allowRequests" },
    { key: "hideNotificationContent", label: "hideContent" },
  ];
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("privacy")} onBack={onBack} />
      <ScrollView>
        {privacy
          ? items.map((item) => (
              <ToggleRow
                key={item.key}
                label={t(item.label)}
                value={privacy[item.key]}
                onChange={(value) => void app.client?.setPrivacy({ [item.key]: value }).then(setPrivacy).catch((error) => app.flash(app.describe(error)))}
              />
            ))
          : <Empty text={t("loading")} />}
      </ScrollView>
    </View>
  );
}

export function BlocksScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const [blocks, setBlocks] = useState<Array<{ peer: PublicUser; since: string }> | null>(null);
  useEffect(() => {
    void app.client?.blocks().then(setBlocks).catch((error) => app.flash(app.describe(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("blockedList")} onBack={onBack} />
      <ScrollView>
        {blocks && blocks.length === 0 ? <Empty text={t("noBlocked")} /> : null}
        {(blocks || []).map((item) => (
          <Row
            key={item.peer.accountSub}
            title={item.peer.displayName}
            subtitle={item.peer.kkNumber ? `${t("kkNumber")} ${item.peer.kkNumber}` : undefined}
            left={<Avatar name={item.peer.displayName} url={item.peer.avatarUrl} />}
            right={
              <Button
                label={t("unblock")}
                kind="ghost"
                onPress={() =>
                  void app.client
                    ?.unblock(item.peer.accountSub)
                    .then(() => setBlocks((prev) => (prev || []).filter((row) => row.peer.accountSub !== item.peer.accountSub)))
                    .catch((error) => app.flash(app.describe(error)))
                }
                style={styles.small}
              />
            }
          />
        ))}
      </ScrollView>
    </View>
  );
}

export function LanguageScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const { t, choice, choose } = useI18n();
  const options: Array<{ value: "system" | "zh" | "en"; label: string }> = [
    { value: "system", label: t("languageFollowSystem") },
    { value: "zh", label: "简体中文" },
    { value: "en", label: "English" },
  ];
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("language")} onBack={onBack} />
      {options.map((option) => (
        <Row key={option.value} title={option.label} right={choice === option.value ? <Text style={{ color: theme.ok }}>✓</Text> : null} onPress={() => choose(option.value)} />
      ))}
    </View>
  );
}

export function DevicesScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const app = useApp();
  const [sessions, setSessions] = useState<Array<{ id: string; platform: string; deviceName: string; appVersion: string; lastSeenAt: string }>>([]);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    void app.client
      ?.request<{ sessions: typeof sessions; current: string | null }>("/api/native/v1/sessions")
      .then((data) => {
        setSessions(data.sessions);
        setCurrent(data.current);
      })
      .catch((error) => app.flash(app.describe(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("devices")} onBack={onBack} />
      <ScrollView>
        {sessions.map((session) => (
          <Row
            key={session.id}
            title={`${session.deviceName || session.platform}${session.id === current ? ` · ${t("thisDevice")}` : ""}`}
            subtitle={`${session.platform} ${session.appVersion} · ${new Date(session.lastSeenAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}`}
          />
        ))}
      </ScrollView>
    </View>
  );
}

export function AboutScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const [update, setUpdate] = useState<UpdateInfo | null | undefined>(undefined);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  async function check() {
    setMessage("");
    try {
      const info = await checkForUpdate();
      setUpdate(info);
      if (!info) setMessage(t("upToDate"));
    } catch (error) {
      setMessage(app.describe(error));
    }
  }

  async function install() {
    if (!update) return;
    setProgress(0);
    setMessage("");
    try {
      await downloadAndInstall(update, setProgress);
    } catch (error) {
      if (error instanceof UpdateError && error.code === "verify") setMessage(t("verifyFailed"));
      else if (error instanceof UpdateError && error.code === "permission") setMessage(t("downloadUpdate"));
      else setMessage(t("networkError"));
    } finally {
      setProgress(null);
    }
  }

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("version")} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.name, { color: theme.ink }]}>KKChat {APP_VERSION}</Text>
        <Muted>{`${PLATFORM} · build ${APP_BUILD} · ${RELEASE_COMMIT}`}</Muted>
        {update ? (
          <View style={styles.stack}>
            <Text style={{ color: theme.ink, fontWeight: "600" }}>{t("updateAvailable", { version: update.version })}</Text>
            {update.changelog ? <Muted>{update.changelog}</Muted> : null}
            <Muted>{`${(update.sizeBytes / 1024 / 1024).toFixed(1)} MB · SHA-256 ${update.sha256.slice(0, 16)}…`}</Muted>
            <Button
              label={progress == null ? t("downloadUpdate") : t("downloading", { percent: progress })}
              busy={progress != null && progress < 1}
              disabled={progress != null}
              onPress={() => void install()}
            />
          </View>
        ) : (
          <Button label={t("checkUpdate")} kind="ghost" onPress={() => void check()} style={styles.cardButton} />
        )}
        {message ? <Muted>{message}</Muted> : null}
      </ScrollView>
    </View>
  );
}

const REASONS: Array<{ value: ReportReason; label: Parameters<ReturnType<typeof useI18n>["t"]>[0] }> = [
  { value: "spam", label: "reasonSpam" },
  { value: "harassment", label: "reasonHarassment" },
  { value: "fraud", label: "reasonFraud" },
  { value: "illegal", label: "reasonIllegal" },
  { value: "other", label: "reasonOther" },
];

export function ReportScreen(props: { targetSub: string; name: string; messageId?: string; conversationId?: string; onBack: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const [reason, setReason] = useState<ReportReason>("spam");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={`${t("reportTitle")} · ${props.name}`} onBack={props.onBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Muted>{t("reportReason")}</Muted>
        {REASONS.map((item) => (
          <Row key={item.value} title={t(item.label)} right={reason === item.value ? <Text style={{ color: theme.ok }}>●</Text> : null} onPress={() => setReason(item.value)} />
        ))}
        <Field label={t("reportDetail")} value={detail} onChangeText={setDetail} multiline maxLength={500} style={{ minHeight: 90, textAlignVertical: "top", paddingTop: 10 }} />
        <Button
          label={t("confirm")}
          busy={busy}
          onPress={() => {
            setBusy(true);
            void app.client
              ?.report({ targetSub: props.targetSub, reason, detail, messageId: props.messageId, conversationId: props.messageId ? undefined : props.conversationId })
              .then(() => {
                app.flash(t("reportSubmitted"));
                props.onBack();
              })
              .catch((error) => app.flash(app.describe(error)))
              .finally(() => setBusy(false));
          }}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 10 },
  card: { alignItems: "center", gap: 4, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 18 },
  name: { fontSize: 20, fontWeight: "700", marginTop: 8 },
  kk: { fontSize: 26, fontWeight: "700" },
  cardButton: { marginTop: 10, alignSelf: "stretch" },
  note: { paddingHorizontal: 16, paddingVertical: 8 },
  signOut: { padding: 16 },
  small: { minHeight: 36, paddingHorizontal: 14 },
  stack: { gap: 10, marginTop: 12 },
});
