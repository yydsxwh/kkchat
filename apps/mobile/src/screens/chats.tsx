import { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { formatMessageTime } from "@shared/i18n";
import type { InboxItem } from "@shared/types";
import { useApp } from "../app-state";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { useTheme } from "../theme";
import { Avatar, Badge, Banner, Button, Empty, Header, Row } from "../ui";

export function ChatsScreen({ split }: { split: boolean }) {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const app = useApp();
  const nav = useNav();
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const activeId = nav.top?.name === "chat" ? nav.top.conversationId : null;

  const items = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return app.inbox;
    return app.inbox.filter((item) => `${item.title} ${item.peer?.kkNumber ?? ""} ${item.peer?.username ?? ""}`.toLowerCase().includes(keyword));
  }, [app.inbox, filter]);

  function open(item: InboxItem) {
    const route = { name: "chat" as const, conversationId: item.id };
    if (split) nav.openDetail(route);
    else nav.push(route);
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header
        title={t("tabChats")}
        subtitle={app.connection === "online" ? undefined : t(app.connection === "offline" ? "offlineBanner" : "reconnecting")}
        right={
          <>
            <Button label={t("scanQr")} kind="ghost" onPress={() => nav.push({ name: "scan" })} style={styles.headerButton} />
            <Button label="+" kind="ghost" accessibilityLabel={t("addFriend")} onPress={() => nav.push({ name: "addFriend" })} style={styles.headerButton} />
          </>
        }
      />
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder={t("searchChats")}
        placeholderTextColor={theme.muted}
        accessibilityLabel={t("searchChats")}
        style={[styles.search, { backgroundColor: theme.card, color: theme.ink, borderColor: theme.line }]}
      />
      {app.connection === "offline" ? <Banner text={t("offlineBanner")} /> : null}
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void app.refreshAll().finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={<Empty text={t("noChats")} />}
        renderItem={({ item }) => (
          <View style={activeId === item.id ? { backgroundColor: theme.card } : undefined}>
            <Row
              title={`${item.pinned ? "📌 " : ""}${item.title}`}
              subtitle={`${item.sourceProduct !== "kkchat" ? `[${t("fromProduct", { product: item.sourceProduct })}] ` : ""}${item.lastMessagePreview || " "}`}
              left={<Avatar name={item.title} url={item.avatarUrl} />}
              right={
                <View style={styles.meta}>
                  <Text style={[styles.time, { color: theme.muted }]}>{formatMessageTime(item.lastMessageAt, locale)}</Text>
                  <Badge count={item.unreadCount} muted={item.muted} />
                </View>
              }
              onPress={() => open(item)}
            />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerButton: { minHeight: 36, paddingHorizontal: 12 },
  search: { marginHorizontal: 12, marginVertical: 10, minHeight: 44, borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, fontSize: 16 },
  meta: { alignItems: "flex-end", gap: 6 },
  time: { fontSize: 12 },
});
