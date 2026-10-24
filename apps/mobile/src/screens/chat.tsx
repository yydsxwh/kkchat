import * as Clipboard from "expo-clipboard";
import { Directory, File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatMessageTime } from "@shared/i18n";
import type { LocalMessage } from "@shared/types";
import { useApp } from "../app-state";
import { accessToken } from "../auth";
import { API_BASE_URL } from "../config";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { useTheme } from "../theme";
import { Avatar, Banner, Button, Header } from "../ui";

/** 每个会话的滚动位置。跨屏 / 收拢 / 旋转后回到原处。 */
const scrollMemory = new Map<string, { offset: number; atBottom: boolean }>();

export function ChatScreen({ conversationId, onBack }: { conversationId: string; onBack?: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t, locale } = useI18n();
  const app = useApp();
  const nav = useNav();
  const listRef = useRef<FlatList<LocalMessage>>(null);
  const memory = scrollMemory.get(conversationId);
  const atBottomRef = useRef(memory?.atBottom ?? true);
  const [token, setToken] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const draft = app.drafts[conversationId] || "";
  const conversation = app.inbox.find((item) => item.id === conversationId) || null;
  const thread = app.threads[conversationId];
  const messages = useMemo(() => thread?.messages || [], [thread]);
  const lastSeq = messages.filter((item) => !item.localStatus).at(-1)?.seq ?? 0;

  useEffect(() => {
    app.setViewing(conversationId);
    void app.openThread(conversationId).catch((error) => app.flash(app.describe(error)));
    const timer = setInterval(() => app.setViewing(conversationId), 20_000);
    return () => {
      clearInterval(timer);
      app.setViewing(null);
    };
    // 只在会话切换时重新进入；app 对象每次渲染都会变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    if (app.accountSub) void accessToken(app.accountSub).then(setToken).catch(() => undefined);
  }, [app.accountSub, lastSeq]);

  useEffect(() => {
    if (atBottomRef.current && lastSeq > 0) app.markRead(conversationId);
    // 新消息到达且停留在底部时推进已读游标。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, lastSeq]);

  const participants = thread?.participants || [];
  const canSend = conversation ? conversation.canSend : true;

  function onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const atBottom = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
    atBottomRef.current = atBottom;
    scrollMemory.set(conversationId, { offset: contentOffset.y, atBottom });
    if (atBottom) app.markRead(conversationId);
  }

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.85, allowsMultipleSelection: false });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    app.sendFile(conversationId, {
      uri: asset.uri,
      name: asset.fileName || `photo-${Date.now()}.jpg`,
      mimeType: asset.mimeType || "image/jpeg",
      kind: "image",
    });
  }

  async function pickFile() {
    const picked = await File.pickFileAsync({});
    if (picked.canceled || !picked.result) return;
    const file = picked.result;
    app.sendFile(conversationId, { uri: file.uri, name: file.name, mimeType: file.type || "application/octet-stream", kind: "file" });
  }

  async function openFile(message: LocalMessage) {
    if (!message.attachment || !app.accountSub) return;
    try {
      const dir = new Directory(Paths.cache, "kkchat-files");
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const target = new File(dir, `${message.attachment.id}-${message.attachment.name}`);
      const file = target.exists
        ? target
        : await File.downloadFileAsync(`${API_BASE_URL}/api/attachments/${message.attachment.id}`, target, {
            headers: { Authorization: `Bearer ${await accessToken(app.accountSub)}` },
            idempotent: true,
          });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: message.attachment.mimeType });
    } catch (error) {
      app.flash(app.describe(error));
    }
  }

  function actions(message: LocalMessage) {
    const mine = message.senderSub === app.accountSub;
    const options: Array<{ label: string; run: () => void; destructive?: boolean }> = [];
    if (message.localStatus === "failed") {
      options.push({ label: t("retry"), run: () => app.retry(message.id) });
      options.push({ label: t("cancel"), run: () => app.discard(message.id), destructive: true });
    } else if (!message.recalledAt && !message.localStatus) {
      if (message.body && message.type === "TEXT") options.push({ label: t("copy"), run: () => void Clipboard.setStringAsync(message.body || "") });
      if (mine && Date.now() - Date.parse(message.createdAt) < 2 * 60 * 1000) {
        options.push({ label: t("recall"), run: () => void app.recall(message.id, conversationId).catch((error) => app.flash(app.describe(error))), destructive: true });
      }
      if (!mine) {
        const sender = participants.find((item) => item.accountSub === message.senderSub);
        options.push({
          label: t("report"),
          run: () => nav.push({ name: "report", targetSub: message.senderSub, displayName: sender?.displayName || conversation?.title || "", messageId: message.id }),
        });
      }
    }
    if (options.length === 0) return;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...options.map((item) => item.label), t("cancel")], cancelButtonIndex: options.length, destructiveButtonIndex: options.findIndex((item) => item.destructive) },
        (index) => options[index]?.run(),
      );
    } else {
      Alert.alert("", undefined, [...options.map((item) => ({ text: item.label, onPress: item.run, style: item.destructive ? ("destructive" as const) : ("default" as const) })), { text: t("cancel"), style: "cancel" }]);
    }
  }

  const banner =
    conversation && !conversation.canSend
      ? conversation.relation === "blocked_by_me"
        ? t("blockedBanner")
        : conversation.kind === "DIRECT"
          ? t("notFriendBanner")
          : t("cannotSendHere")
      : null;

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: theme.bg }]} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={0}>
      <Header
        title={conversation?.title || t("loading")}
        subtitle={
          conversation?.kind === "DIRECT"
            ? [conversation.peer?.kkNumber ? `${t("kkNumber")} ${conversation.peer.kkNumber}` : "", conversation.peer?.username ? `@${conversation.peer.username}` : ""].filter(Boolean).join(" · ")
            : conversation
              ? t("members", { count: participants.length })
              : undefined
        }
        onBack={onBack}
        right={
          conversation?.peer ? (
            <Button label={t("profile")} kind="ghost" onPress={() => nav.push({ name: "profile", sub: conversation.peer!.accountSub })} style={styles.headerButton} />
          ) : null
        }
      />
      {app.connection === "offline" ? <Banner text={t("offlineBanner")} /> : null}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        onScroll={onScroll}
        scrollEventThrottle={100}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => {
          if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
        }}
        onLayout={() => {
          if (memory && !memory.atBottom) listRef.current?.scrollToOffset({ offset: memory.offset, animated: false });
        }}
        ListHeaderComponent={
          thread?.hasMore ? (
            <Button
              label={t("loadEarlier")}
              kind="ghost"
              busy={loadingEarlier}
              onPress={() => {
                setLoadingEarlier(true);
                atBottomRef.current = false;
                void app.loadEarlier(conversationId).finally(() => setLoadingEarlier(false));
              }}
              style={styles.earlier}
            />
          ) : messages.length > 30 ? (
            <Text style={[styles.center, { color: theme.muted }]}>{t("noMoreMessages")}</Text>
          ) : undefined
        }
        renderItem={({ item }) => {
          const mine = item.senderSub === app.accountSub;
          const sender = participants.find((participant) => participant.accountSub === item.senderSub);
          return (
            <Pressable onLongPress={() => actions(item)} onPress={() => (item.localStatus === "failed" ? actions(item) : undefined)} style={[styles.message, mine ? styles.mine : styles.theirs]}>
              {!mine ? <Avatar name={sender?.displayName || conversation?.title || "?"} url={sender?.avatarUrl} size={34} /> : null}
              <View style={[styles.bubbleWrap, mine ? styles.alignEnd : styles.alignStart]}>
                {!mine && conversation?.kind !== "DIRECT" ? <Text style={[styles.sender, { color: theme.muted }]}>{sender?.displayName || ""}</Text> : null}
                <MessageBody message={item} mine={mine} token={token} onOpenFile={() => void openFile(item)} />
                <View style={styles.meta}>
                  <Text style={[styles.metaText, { color: theme.muted }]}>{formatMessageTime(item.createdAt, locale)}</Text>
                  {item.localStatus === "sending" ? <Text style={[styles.metaText, { color: theme.muted }]}>{t("sending")}</Text> : null}
                  {item.localStatus === "failed" ? <Text style={[styles.metaText, { color: theme.danger }]}>{`${t("failed")} · ${t("tapToRetry")}`}</Text> : null}
                  {mine && !item.localStatus && !item.recalledAt && conversation?.kind === "DIRECT" ? (
                    <Text style={[styles.metaText, { color: theme.muted }]}>{t(item.read ? "read" : "unread")}</Text>
                  ) : null}
                </View>
              </View>
            </Pressable>
          );
        }}
      />
      {banner ? (
        <View style={{ paddingBottom: insets.bottom }}>
          <Banner
            text={banner}
            action={conversation?.peer && conversation.relation === "not_friends" ? t("addFriend") : undefined}
            onAction={() => conversation?.peer && nav.push({ name: "profile", sub: conversation.peer.accountSub })}
          />
        </View>
      ) : (
        <View style={[styles.composer, { borderTopColor: theme.line, backgroundColor: theme.panel, paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("photo")} onPress={() => void pickImage()} style={[styles.iconButton, { borderColor: theme.line }]}>
            <Text style={styles.icon}>🖼</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t("file")} onPress={() => void pickFile()} style={[styles.iconButton, { borderColor: theme.line }]}>
            <Text style={styles.icon}>📎</Text>
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={(text) => app.setDraft(conversationId, text)}
            placeholder={t("typeMessage")}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t("typeMessage")}
            multiline
            editable={canSend}
            style={[styles.input, { color: theme.ink, backgroundColor: theme.card, borderColor: theme.line }]}
          />
          <Button
            label={t("send")}
            disabled={!draft.trim()}
            onPress={() => {
              atBottomRef.current = true;
              app.sendText(conversationId, draft);
              app.setDraft(conversationId, "");
            }}
            style={styles.send}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function MessageBody({ message, mine, token, onOpenFile }: { message: LocalMessage; mine: boolean; token: string | null; onOpenFile: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const bubble = [styles.bubble, { backgroundColor: mine ? theme.mine : theme.theirs }];
  const ink = { color: mine ? theme.mineInk : theme.ink };
  if (message.recalledAt) return <Text style={[styles.recalled, { color: theme.muted }]}>{t("recalled")}</Text>;
  if (message.type === "IMAGE" && message.attachment && token) {
    const ratio = message.attachment.width && message.attachment.height ? message.attachment.width / message.attachment.height : 1;
    return (
      <Image
        source={{ uri: `${API_BASE_URL}/api/attachments/${message.attachment.id}`, headers: { Authorization: `Bearer ${token}` } }}
        style={[styles.image, { aspectRatio: Math.max(0.4, Math.min(2.5, ratio)) }]}
        accessibilityLabel={message.attachment.name}
      />
    );
  }
  if (message.type === "FILE" && message.attachment) {
    return (
      <Pressable onPress={onOpenFile} style={bubble} accessibilityRole="button" accessibilityLabel={`${t("openFile")} ${message.attachment.name}`}>
        <Text style={ink}>📄 {message.attachment.name}</Text>
      </Pressable>
    );
  }
  if ((message.type === "IMAGE" || message.type === "FILE") && message.localStatus) {
    return (
      <View style={bubble}>
        <Text style={ink}>{message.type === "IMAGE" ? "🖼" : "📄"} {message.body}</Text>
      </View>
    );
  }
  return (
    <View style={bubble}>
      <Text style={[styles.text, ink]} selectable>
        {message.body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerButton: { minHeight: 36, paddingHorizontal: 12 },
  list: { padding: 12, gap: 10 },
  earlier: { alignSelf: "center", minHeight: 36, marginBottom: 8 },
  center: { textAlign: "center", fontSize: 12, marginBottom: 8 },
  message: { flexDirection: "row", gap: 8, maxWidth: "92%" },
  mine: { alignSelf: "flex-end", flexDirection: "row-reverse" },
  theirs: { alignSelf: "flex-start" },
  bubbleWrap: { gap: 4, flexShrink: 1 },
  alignEnd: { alignItems: "flex-end" },
  alignStart: { alignItems: "flex-start" },
  sender: { fontSize: 12 },
  bubble: { borderRadius: 18, paddingHorizontal: 12, paddingVertical: 9 },
  text: { fontSize: 16, lineHeight: 22 },
  recalled: { fontStyle: "italic", fontSize: 14, paddingVertical: 6 },
  image: { width: 220, borderRadius: 14, backgroundColor: "#ddd" },
  meta: { flexDirection: "row", gap: 8 },
  metaText: { fontSize: 11 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  iconButton: { width: 44, height: 44, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  icon: { fontSize: 18 },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 11, fontSize: 16 },
  send: { minHeight: 44, paddingHorizontal: 16 },
});
