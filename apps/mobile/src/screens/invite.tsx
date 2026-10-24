import { CameraView, scanFromURLAsync, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Share, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { newClientId } from "@shared/client";
import type { PublicUser, Relationship } from "@shared/types";
import { useApp } from "../app-state";
import { API_BASE_URL } from "../config";
import { parseInviteToken } from "../links";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { useTheme } from "../theme";
import { Avatar, Button, Field, Header, Muted } from "../ui";

/** 只接受本站的邀请链接（https://kkchat…/i/<token> 或 kkchat://i/<token>）。其他二维码内容不打开。 */
export function inviteTokenFrom(text: string): string | null {
  return parseInviteToken(text, API_BASE_URL);
}

export function ScanScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const nav = useNav();
  const app = useApp();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  function handle(data: string) {
    if (handled.current) return;
    const token = inviteTokenFrom(data);
    if (!token) {
      app.flash(t("inviteInvalid"));
      return;
    }
    handled.current = true;
    nav.replace({ name: "invite", token });
  }

  async function fromPhoto() {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (picked.canceled || !picked.assets[0]) return;
    const results = await scanFromURLAsync(picked.assets[0].uri, ["qr"]);
    if (results[0]) handle(results[0].data);
    else app.flash(t("noResults"));
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("scanQr")} onBack={onBack} />
      {permission?.granted ? (
        <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => handle(data)} />
      ) : (
        <View style={styles.padded}>
          <Muted>{permission && !permission.canAskAgain ? t("cameraDenied") : t("scanQr")}</Muted>
          {permission?.canAskAgain !== false ? <Button label={t("confirm")} onPress={() => void requestPermission()} /> : null}
        </View>
      )}
      <View style={styles.padded}>
        <Button label={t("scanFromImage")} kind="ghost" onPress={() => void fromPhoto()} />
        <Button label={t("addFriend")} kind="ghost" onPress={() => nav.replace({ name: "addFriend" })} />
      </View>
    </View>
  );
}

export function MyQrScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    try {
      setInvite(await app.client!.createInvite());
    } catch (error) {
      app.flash(app.describe(error));
    }
  }

  useEffect(() => {
    void create();
    // 打开页面时生成一次邀请。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("myQr")} onBack={onBack} />
      <ScrollView contentContainerStyle={[styles.padded, styles.center]}>
        {app.me ? (
          <View style={styles.owner}>
            <Avatar name={app.me.displayName} url={app.me.avatarUrl} />
            <View>
              <Text style={[styles.name, { color: theme.ink }]}>{app.me.displayName}</Text>
              <Muted>{app.me.kkNumber ? `${t("kkNumber")} ${app.me.kkNumber}` : ""}</Muted>
            </View>
          </View>
        ) : null}
        <View style={styles.qr}>{invite ? <QRCode value={invite.url} size={240} backgroundColor="white" color="#1c1915" /> : <Muted>{t("loading")}</Muted>}</View>
        <Muted>{t("myQrHint")}</Muted>
        {invite ? (
          <>
            <Text selectable style={[styles.link, { color: theme.muted }]}>
              {invite.url}
            </Text>
            <Button label={t("shareLink")} onPress={() => void Share.share({ message: `${t("inviteFrom", { name: app.me?.displayName || "" })}\n${invite.url}`, url: invite.url })} />
            <Button
              label={copied ? t("copied") : t("copyLink")}
              kind="ghost"
              onPress={() => void Clipboard.setStringAsync(invite.url).then(() => setCopied(true))}
            />
            <Button label={t("resetQr")} kind="ghost" onPress={() => void app.client?.revokeInvites().then(create)} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

export function InviteScreen({ token, onBack }: { token: string; onBack: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const nav = useNav();
  const [owner, setOwner] = useState<PublicUser | null>(null);
  const [rel, setRel] = useState<Relationship | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState(t("requestMessageDefault", { name: app.me?.displayName || "" }));
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [clientRequestId] = useState(() => newClientId());

  useEffect(() => {
    void app.client
      ?.resolveInvite(token)
      .then((data) => {
        setOwner(data.owner);
        setRel(data.relationship);
      })
      .catch((caught) => setError(app.describe(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function send() {
    setState("busy");
    try {
      const result = await app.client!.requestViaInvite(token, { message: note, clientRequestId });
      setState("sent");
      if (result.state === "already_friends" && result.conversationId) nav.openDetail({ name: "chat", conversationId: result.conversationId });
      void app.refreshContacts();
    } catch (caught) {
      setState("idle");
      setError(app.describe(caught));
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("addFriend")} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.padded} keyboardShouldPersistTaps="handled">
        {error ? <Muted>{error}</Muted> : null}
        {owner ? (
          <>
            <View style={styles.owner}>
              <Avatar name={owner.displayName} url={owner.avatarUrl} size={56} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: theme.ink }]}>{t("inviteFrom", { name: owner.displayName })}</Text>
                <Muted>{[owner.kkNumber ? `${t("kkNumber")} ${owner.kkNumber}` : "", owner.username ? `@${owner.username}` : ""].filter(Boolean).join(" · ")}</Muted>
              </View>
            </View>
            <Muted>{t("inviteCurrentAccount", { name: app.me?.displayName || "" })}</Muted>
            {rel?.isSelf ? (
              <Muted>{t("myQrHint")}</Muted>
            ) : rel?.friend ? (
              <Text style={{ color: theme.ok, fontWeight: "600" }}>{t("alreadyFriends")}</Text>
            ) : state === "sent" || rel?.outgoing ? (
              <Text style={{ color: theme.ok, fontWeight: "600" }}>{t("requestSent")}</Text>
            ) : rel?.incoming ? (
              <Button label={t("accept")} onPress={() => nav.replace({ name: "profile", sub: owner.accountSub })} />
            ) : (
              <>
                <Field label={t("requestMessage")} value={note} onChangeText={setNote} maxLength={120} />
                <Button label={t("sendRequest")} busy={state === "busy"} onPress={() => void send()} />
              </>
            )}
          </>
        ) : !error ? (
          <Muted>{t("loading")}</Muted>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  camera: { flex: 1, minHeight: 280 },
  padded: { padding: 16, gap: 10 },
  center: { alignItems: "stretch" },
  owner: { flexDirection: "row", alignItems: "center", gap: 12 },
  name: { fontSize: 18, fontWeight: "700" },
  qr: { alignSelf: "center", padding: 16, backgroundColor: "white", borderRadius: 20, marginVertical: 8 },
  link: { fontSize: 12, textAlign: "center" },
});
