import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError, newClientId } from "@shared/client";
import type { Relationship, SearchHit } from "@shared/types";
import { useApp } from "../app-state";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { useTheme } from "../theme";
import { Avatar, Badge, Button, Empty, Field, Header, Muted, Row, Section } from "../ui";

function peerLine(peer: { kkNumber: number | null; username: string | null }, kkLabel: string) {
  return [peer.kkNumber ? `${kkLabel} ${peer.kkNumber}` : "", peer.username ? `@${peer.username}` : ""].filter(Boolean).join(" · ");
}

export function ContactsScreen({ split }: { split: boolean }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const nav = useNav();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void app.refreshContacts().catch(() => undefined);
    // 进入联系人页时刷新一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const friends = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return app.friends;
    return app.friends.filter((item) => `${item.remark} ${item.peer.displayName} ${item.peer.kkNumber ?? ""} ${item.peer.username ?? ""}`.toLowerCase().includes(keyword));
  }, [app.friends, filter]);

  const openProfile = (sub: string) => (split ? nav.openDetail({ name: "profile", sub }) : nav.push({ name: "profile", sub }));

  async function respond(id: string, action: "accept" | "reject" | "cancel") {
    try {
      await app.client?.respond(id, action);
      await app.refreshContacts();
      await app.refreshAll();
    } catch (error) {
      app.flash(app.describe(error));
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("tabContacts")} right={<Badge count={app.requests.incoming.length} />} />
      <FlatList
        data={friends}
        keyExtractor={(item) => item.peer.accountSub}
        ListHeaderComponent={
          <View>
            <View style={styles.actions}>
              <Button label={t("addFriend")} onPress={() => nav.push({ name: "addFriend" })} style={styles.action} />
              <Button label={t("myQr")} kind="ghost" onPress={() => nav.push({ name: "myQr" })} style={styles.action} />
              <Button label={t("scanQr")} kind="ghost" onPress={() => nav.push({ name: "scan" })} style={styles.action} />
            </View>
            {app.requests.incoming.length > 0 ? (
              <Section title={t("incomingRequests")}>
                {app.requests.incoming.map((request) => (
                  <View key={request.id} style={[styles.request, { borderBottomColor: theme.line }]}>
                    <Row
                      title={request.peer.displayName}
                      subtitle={request.message || peerLine(request.peer, t("kkNumber"))}
                      left={<Avatar name={request.peer.displayName} url={request.peer.avatarUrl} />}
                      onPress={() => openProfile(request.peer.accountSub)}
                    />
                    <View style={styles.requestButtons}>
                      <Button label={t("accept")} onPress={() => void respond(request.id, "accept")} style={styles.small} />
                      <Button label={t("reject")} kind="ghost" onPress={() => void respond(request.id, "reject")} style={styles.small} />
                    </View>
                  </View>
                ))}
              </Section>
            ) : null}
            {app.requests.outgoing.length > 0 ? (
              <Section title={t("outgoingRequests")}>
                {app.requests.outgoing.map((request) => (
                  <Row
                    key={request.id}
                    title={request.peer.displayName}
                    subtitle={t("requestSent")}
                    left={<Avatar name={request.peer.displayName} url={request.peer.avatarUrl} />}
                    right={<Button label={t("withdraw")} kind="ghost" onPress={() => void respond(request.id, "cancel")} style={styles.small} />}
                    onPress={() => openProfile(request.peer.accountSub)}
                  />
                ))}
              </Section>
            ) : null}
            <Section title={t("friends")}>
              <TextInput
                value={filter}
                onChangeText={setFilter}
                placeholder={t("filterFriends")}
                placeholderTextColor={theme.muted}
                accessibilityLabel={t("filterFriends")}
                style={[styles.search, { backgroundColor: theme.card, color: theme.ink, borderColor: theme.line }]}
              />
            </Section>
          </View>
        }
        ListEmptyComponent={<Empty text={t("noFriends")} />}
        renderItem={({ item }) => (
          <Row
            title={item.remark || item.peer.displayName}
            subtitle={peerLine(item.peer, t("kkNumber"))}
            left={<Avatar name={item.remark || item.peer.displayName} url={item.peer.avatarUrl} />}
            onPress={() => openProfile(item.peer.accountSub)}
          />
        )}
      />
    </View>
  );
}

export function AddFriendScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const nav = useNav();
  const [keyword, setKeyword] = useState("");
  const [note, setNote] = useState(t("requestMessageDefault", { name: app.me?.displayName || "" }));
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<Record<string, string>>({});

  async function search() {
    const text = keyword.trim();
    if (!text || !app.client) return;
    setBusy(true);
    setMessage("");
    try {
      let users = await app.client.search(text);
      if (users.length === 0 && /^[a-zA-Z][a-zA-Z0-9_]{3,19}$/.test(text)) users = await app.client.searchByName(text);
      setHits(users);
      if (users.length === 0) setMessage(t("noResults"));
    } catch (error) {
      setMessage(app.describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function request(hit: SearchHit) {
    if (!app.client) return;
    try {
      const result = await app.client.sendRequest({ addresseeSub: hit.accountSub, message: note, source: "search", clientRequestId: newClientId() });
      setSent((prev) => ({
        ...prev,
        [hit.accountSub]: result.state === "already_friends" ? t("alreadyFriends") : result.state === "incoming_pending" ? t("requestIncoming") : t("requestSent"),
      }));
      void app.refreshContacts();
    } catch (error) {
      setSent((prev) => ({ ...prev, [hit.accountSub]: error instanceof ApiError ? error.message : t("networkError") }));
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("addFriend")} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.padded} keyboardShouldPersistTaps="handled">
        <Field
          value={keyword}
          onChangeText={setKeyword}
          placeholder={t("searchUsersPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={() => void search()}
          accessibilityLabel={t("searchUsersPlaceholder")}
        />
        <Muted>{t("searchUsersHint")}</Muted>
        <Field label={t("requestMessage")} value={note} onChangeText={setNote} maxLength={120} />
        <Button label={t("confirm")} onPress={() => void search()} busy={busy} />
        <View style={styles.quick}>
          <Button label={t("scanQr")} kind="ghost" onPress={() => nav.push({ name: "scan" })} style={styles.action} />
          <Button label={t("myQr")} kind="ghost" onPress={() => nav.push({ name: "myQr" })} style={styles.action} />
        </View>
        {message ? <Muted>{message}</Muted> : null}
        {hits.map((hit) => (
          <View key={hit.accountSub} style={[styles.hit, { borderColor: theme.line, backgroundColor: theme.card }]}>
            <Row title={hit.displayName} subtitle={peerLine(hit, t("kkNumber"))} left={<Avatar name={hit.displayName} url={hit.avatarUrl} />} onPress={() => nav.push({ name: "profile", sub: hit.accountSub })} />
            <View style={styles.hitAction}>
              {sent[hit.accountSub] ? (
                <Text style={{ color: theme.ok }}>{sent[hit.accountSub]}</Text>
              ) : hit.relation === "friend" ? (
                <Text style={{ color: theme.ok }}>{t("alreadyFriends")}</Text>
              ) : hit.relation === "outgoing" ? (
                <Text style={{ color: theme.muted }}>{t("requestSent")}</Text>
              ) : hit.relation === "incoming" ? (
                <Button label={t("accept")} onPress={() => nav.push({ name: "profile", sub: hit.accountSub })} style={styles.small} />
              ) : hit.relation === "blocked_by_me" ? (
                <Text style={{ color: theme.muted }}>{t("blockedList")}</Text>
              ) : (
                <Button label={t("addFriend")} onPress={() => void request(hit)} style={styles.small} />
              )}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

export function ProfileScreen({ sub, onBack }: { sub: string; onBack?: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  const app = useApp();
  const nav = useNav();
  const [rel, setRel] = useState<Relationship | null>(null);
  const [remark, setRemark] = useState("");
  const [note, setNote] = useState(t("requestMessageDefault", { name: app.me?.displayName || "" }));
  const [error, setError] = useState("");

  async function load() {
    if (!app.client) return;
    try {
      const data = await app.client.relationship(sub);
      setRel(data);
      setRemark(data.remark);
    } catch (caught) {
      setError(app.describe(caught));
    }
  }

  useEffect(() => {
    void load();
    // 资料页按 sub 重新加载；好友事件到达时 friends 列表变化也刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, app.friends, app.requests]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await Promise.all([load(), app.refreshContacts(), app.refreshAll()]);
    } catch (caught) {
      app.flash(app.describe(caught));
    }
  }

  async function message() {
    if (!app.client || !rel) return;
    try {
      const conversationId = rel.conversationId || (await app.client.openDirect(sub)).conversationId;
      nav.openDetail({ name: "chat", conversationId });
    } catch (caught) {
      app.flash(app.describe(caught));
    }
  }

  const confirm = (body: string, run: () => void) =>
    Alert.alert("", body, [
      { text: t("cancel"), style: "cancel" },
      { text: t("confirm"), style: "destructive", onPress: run },
    ]);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t("profile")} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.padded} keyboardShouldPersistTaps="handled">
        {error ? <Muted>{error}</Muted> : null}
        {rel ? (
          <>
            <View style={styles.profileHead}>
              <Avatar name={rel.remark || rel.peer.displayName} url={rel.peer.avatarUrl} size={72} />
              <Text style={[styles.name, { color: theme.ink }]}>{rel.remark || rel.peer.displayName}</Text>
              {rel.remark ? <Muted>{rel.peer.displayName}</Muted> : null}
              <Text style={[styles.kk, { color: theme.ink }]}>{rel.peer.kkNumber ?? "—"}</Text>
              <Muted>{`${t("kkNumber")} · ${rel.peer.username ? `@${rel.peer.username}` : t("noUsername")}`}</Muted>
            </View>
            {rel.isSelf ? null : rel.friend ? (
              <View style={styles.stack}>
                <Text style={{ color: theme.ok, fontWeight: "600" }}>{t("alreadyFriends")}</Text>
                <Button label={t("message")} onPress={() => void message()} />
                <Field label={t("remark")} value={remark} onChangeText={setRemark} placeholder={t("remarkPlaceholder")} maxLength={40} />
                <Button label={t("setRemark")} kind="ghost" onPress={() => void act(() => app.client!.setRemark(sub, remark))} />
                <Button label={t("deleteFriend")} kind="danger" onPress={() => confirm(t("deleteFriendConfirm"), () => void act(() => app.client!.removeFriend(sub)))} />
              </View>
            ) : rel.incoming ? (
              <View style={styles.stack}>
                <Text style={{ color: theme.ink }}>{t("requestIncoming")}</Text>
                {rel.incoming.message ? <Muted>{rel.incoming.message}</Muted> : null}
                <Button label={t("accept")} onPress={() => void act(() => app.client!.respond(rel.incoming!.id, "accept"))} />
                <Button label={t("reject")} kind="ghost" onPress={() => void act(() => app.client!.respond(rel.incoming!.id, "reject"))} />
              </View>
            ) : rel.outgoing ? (
              <View style={styles.stack}>
                <Text style={{ color: theme.muted }}>{t("requestSent")}</Text>
                <Button label={t("withdraw")} kind="ghost" onPress={() => void act(() => app.client!.respond(rel.outgoing!.id, "cancel"))} />
              </View>
            ) : rel.blockedByMe ? null : (
              <View style={styles.stack}>
                <Field label={t("requestMessage")} value={note} onChangeText={setNote} maxLength={120} />
                <Button
                  label={t("sendRequest")}
                  onPress={() => void act(() => app.client!.sendRequest({ addresseeSub: sub, message: note, source: "profile", clientRequestId: newClientId() }))}
                />
              </View>
            )}
            {!rel.isSelf ? (
              <View style={styles.stack}>
                {!rel.friend && rel.canMessage ? <Button label={t("message")} kind="ghost" onPress={() => void message()} /> : null}
                {rel.blockedByMe ? (
                  <Button label={t("unblock")} kind="ghost" onPress={() => void act(() => app.client!.unblock(sub))} />
                ) : (
                  <Button label={t("block")} kind="danger" onPress={() => confirm(t("blockConfirm"), () => void act(() => app.client!.block(sub)))} />
                )}
                <Button
                  label={t("report")}
                  kind="ghost"
                  onPress={() => nav.push({ name: "report", targetSub: sub, displayName: rel.peer.displayName, conversationId: rel.conversationId || undefined })}
                />
              </View>
            ) : null}
          </>
        ) : (
          <Muted>{t("loading")}</Muted>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  padded: { padding: 16, gap: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 },
  action: { minHeight: 40 },
  quick: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  request: { borderBottomWidth: StyleSheet.hairlineWidth },
  requestButtons: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  small: { minHeight: 36, paddingHorizontal: 14 },
  search: { marginHorizontal: 12, minHeight: 44, borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, fontSize: 16 },
  hit: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, overflow: "hidden" },
  hitAction: { paddingHorizontal: 16, paddingBottom: 12, alignItems: "flex-start" },
  profileHead: { alignItems: "center", gap: 4, paddingVertical: 12 },
  name: { fontSize: 22, fontWeight: "700", marginTop: 8 },
  kk: { fontSize: 28, fontWeight: "700", marginTop: 6 },
  stack: { gap: 10, marginTop: 12 },
});
