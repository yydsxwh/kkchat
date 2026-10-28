import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useEffect, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AppStateProvider, useApp } from "./app-state";
import { I18nProvider, useI18n } from "./i18n";
import { useFoldLayout, type FoldLayout } from "./layout";
import { NavProvider, useNav, type Route, type Tab } from "./nav";
import { ChatScreen } from "./screens/chat";
import { ChatsScreen } from "./screens/chats";
import { AddFriendScreen, ContactsScreen, ProfileScreen } from "./screens/contacts";
import { InviteScreen, MyQrScreen, ScanScreen, inviteTokenFrom } from "./screens/invite";
import { LoginScreen } from "./screens/login";
import { AboutScreen, BlocksScreen, DevicesScreen, LanguageScreen, MeScreen, PrivacyScreen, ReportScreen } from "./screens/me";
import { useTheme } from "./theme";
import { Badge, Muted } from "./ui";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export default function App() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <AppStateProvider>
          <NavProvider>
            <Root />
          </NavProvider>
        </AppStateProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const app = useApp();
  const theme = useTheme();
  useDeepLinks();
  if (app.phase === "booting") {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      {app.phase === "signedOut" ? <LoginScreen /> : <Shell />}
      {app.notice ? (
        <View pointerEvents="none" style={styles.toastWrap}>
          <Text style={[styles.toast, { backgroundColor: theme.ink, color: theme.bg }]}>{app.notice}</Text>
        </View>
      ) : null}
    </>
  );
}

/**
 * 邀请链接 / 二维码落地：https://kkchat…/i/<token>、kkchat://i/<token>。
 * 没登录时先记住目标，登录完成后回到这里，不会回到首页找不到要添加的人。
 */
function useDeepLinks() {
  const app = useApp();
  const nav = useNav();
  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url && inviteTokenFrom(url)) app.setPendingLink(url);
    });
    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (inviteTokenFrom(url)) app.setPendingLink(url);
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (app.phase !== "ready" || !app.pendingLink || !app.client) return;
    const token = inviteTokenFrom(app.pendingLink);
    app.setPendingLink(null);
    if (token) nav.openDetail({ name: "invite", token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.phase, app.pendingLink, app.client]);

  useEffect(() => {
    // 点通知进入会话前重新核对当前账号；不是当前账号的通知不打开正文。
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { conversationId?: string; accountSub?: string };
      if (!data.conversationId || data.accountSub !== app.accountSub) return;
      nav.setTab("chats");
      nav.openDetail({ name: "chat", conversationId: data.conversationId });
    });
    return () => subscription.remove();
  }, [app.accountSub, nav]);
}

function Shell() {
  const theme = useTheme();
  const nav = useNav();
  const { layout } = useFoldLayout();
  const split = layout.mode !== "single";
  const root = <TabRoot split={split} />;
  const detail = nav.top ? <RouteView route={nav.top} split={split} /> : <Placeholder />;
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.bg }]} edges={["top", "left", "right"]}>
      <SplitLayout layout={layout} first={root} second={detail} showSecond={Boolean(nav.top)} />
    </SafeAreaView>
  );
}

/**
 * 单栏：两块都挂着，只显示一块（display:none），展开 / 收拢不会重建页面。
 * 竖向铰链：左列表、右详情，中间留出铰链宽度。横向铰链：上列表、下详情，输入框始终在下半屏内。
 */
function SplitLayout({ layout, first, second, showSecond }: { layout: FoldLayout; first: ReactNode; second: ReactNode; showSecond: boolean }) {
  const theme = useTheme();
  if (layout.mode === "single") {
    return (
      <View style={styles.flex}>
        <View style={[styles.flex, showSecond ? styles.hidden : null]}>{first}</View>
        <View style={[styles.flex, showSecond ? null : styles.hidden]}>{second}</View>
      </View>
    );
  }
  if (layout.mode === "split-row") {
    return (
      <View style={[styles.flex, styles.row]} testID={`layout-split-row-${layout.source}`}>
        <View style={{ width: layout.first }}>{first}</View>
        <View style={{ width: layout.gap, backgroundColor: layout.source === "hinge" ? theme.hinge : theme.line }} />
        <View style={styles.flex}>{second}</View>
      </View>
    );
  }
  return (
    <View style={styles.flex} testID="layout-split-column-hinge">
      <View style={{ height: layout.first }}>{first}</View>
      <View style={{ height: layout.gap, backgroundColor: theme.hinge }} />
      <View style={styles.flex}>{second}</View>
    </View>
  );
}

function Placeholder() {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <View style={[styles.center, { backgroundColor: theme.bg }]}>
      <Muted>{t("tagline")}</Muted>
    </View>
  );
}

function TabRoot({ split }: { split: boolean }) {
  const theme = useTheme();
  const nav = useNav();
  const app = useApp();
  const { t } = useI18n();
  const unread = app.inbox.reduce((sum, item) => sum + (item.muted ? 0 : item.unreadCount), 0);
  const tabs: Array<{ id: Tab; label: string; badge: number }> = [
    { id: "chats", label: t("tabChats"), badge: unread },
    { id: "contacts", label: t("tabContacts"), badge: app.requests.incoming.length },
    { id: "me", label: t("tabMe"), badge: 0 },
  ];
  return (
    <View style={styles.flex}>
      <View style={styles.flex}>
        {nav.tab === "chats" ? <ChatsScreen split={split} /> : nav.tab === "contacts" ? <ContactsScreen split={split} /> : <MeScreen />}
      </View>
      <SafeAreaView edges={["bottom"]} style={[styles.tabBar, { borderTopColor: theme.line, backgroundColor: theme.panel }]}>
        {tabs.map((tab) => (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: nav.tab === tab.id }}
            accessibilityLabel={tab.label}
            onPress={() => nav.setTab(tab.id)}
            style={styles.tab}
          >
            <Text style={[styles.tabText, { color: nav.tab === tab.id ? theme.ink : theme.muted, fontWeight: nav.tab === tab.id ? "700" : "500" }]}>{tab.label}</Text>
            <View style={styles.tabBadge}>
              <Badge count={tab.badge} />
            </View>
          </Pressable>
        ))}
      </SafeAreaView>
    </View>
  );
}

function RouteView({ route, split }: { route: Route; split: boolean }) {
  const nav = useNav();
  const back = () => nav.pop();
  const backOrNone = split && nav.stack.length <= 1 ? undefined : back;
  switch (route.name) {
    case "chat":
      return <ChatScreen key={route.conversationId} conversationId={route.conversationId} onBack={backOrNone} />;
    case "profile":
      return <ProfileScreen key={route.sub} sub={route.sub} onBack={backOrNone} />;
    case "addFriend":
      return <AddFriendScreen onBack={back} />;
    case "scan":
      return <ScanScreen onBack={back} />;
    case "myQr":
      return <MyQrScreen onBack={back} />;
    case "invite":
      return <InviteScreen key={route.token} token={route.token} onBack={back} />;
    case "privacy":
      return <PrivacyScreen onBack={back} />;
    case "blocks":
      return <BlocksScreen onBack={back} />;
    case "language":
      return <LanguageScreen onBack={back} />;
    case "devices":
      return <DevicesScreen onBack={back} />;
    case "about":
      return <AboutScreen onBack={back} />;
    case "report":
      return <ReportScreen targetSub={route.targetSub} name={route.displayName} messageId={route.messageId} conversationId={route.conversationId} onBack={back} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row" },
  hidden: { display: "none" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  tabBar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, minHeight: 54, alignItems: "center", justifyContent: "center" },
  tabText: { fontSize: 14 },
  tabBadge: { position: "absolute", top: 4, right: "22%" },
  toastWrap: { position: "absolute", left: 0, right: 0, bottom: 90, alignItems: "center" },
  toast: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, overflow: "hidden", maxWidth: "90%" },
});
