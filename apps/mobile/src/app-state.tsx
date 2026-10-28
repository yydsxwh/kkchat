import NetInfo from "@react-native-community/netinfo";
import * as Notifications from "expo-notifications";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import { ApiError, createClient, newClientId, type KkchatClient } from "@shared/client";
import { translate, type Locale } from "@shared/i18n";
import { applyPeerRead, bumpInbox, mergeMessages, SeqCursor, sortInbox } from "@shared/merge";
import type { FriendRequestView, FriendView, InboxItem, LocalMessage, Me, Participant, PublicMessage } from "@shared/types";
import {
  accessToken,
  AuthError,
  currentAccountSub,
  listAccounts,
  loadSession,
  refreshSession,
  setCurrentAccount,
  signIn,
  signOut,
  updateAccountSummary,
  type AccountSummary,
} from "./auth";
import { API_BASE_URL } from "./config";
import { useI18n } from "./i18n";
import { RealtimeConnection, type RealtimePayload } from "./realtime";
import { readAccountJson, readPrefs, writeAccountJson } from "./storage";

export type ThreadState = { messages: LocalMessage[]; hasMore: boolean; participants: Participant[]; loaded: boolean };
export type Connection = "online" | "connecting" | "offline";

/** 离线待发队列。clientMessageId 固定：超时重试、App 重启、联网后重放都用同一个，服务端只落一次。 */
export type OutboxItem = {
  localId: string;
  conversationId: string;
  clientMessageId: string;
  type: "TEXT" | "IMAGE" | "FILE";
  body: string;
  file?: { uri: string; name: string; mimeType: string; kind: "image" | "file"; attachmentId?: string };
  createdAt: string;
  attempts: number;
  status: "pending" | "sending" | "failed";
  error?: string;
};

type Phase = "booting" | "signedOut" | "ready";

type AppStateValue = {
  phase: Phase;
  accountSub: string | null;
  me: Me | null;
  accounts: AccountSummary[];
  client: KkchatClient | null;
  inbox: InboxItem[];
  friends: FriendView[];
  requests: { incoming: FriendRequestView[]; outgoing: FriendRequestView[] };
  threads: Record<string, ThreadState>;
  drafts: Record<string, string>;
  outbox: OutboxItem[];
  connection: Connection;
  notice: string | null;
  pendingLink: string | null;
  setPendingLink(url: string | null): void;
  signInFlow(options?: { prompt?: "login" }): Promise<void>;
  switchAccount(sub: string): Promise<void>;
  signOutCurrent(): Promise<void>;
  refreshAll(): Promise<void>;
  refreshContacts(): Promise<void>;
  openThread(conversationId: string): Promise<void>;
  loadEarlier(conversationId: string): Promise<void>;
  setViewing(conversationId: string | null): void;
  markRead(conversationId: string): void;
  setDraft(conversationId: string, text: string): void;
  sendText(conversationId: string, text: string): void;
  sendFile(conversationId: string, file: NonNullable<OutboxItem["file"]>): void;
  retry(localId: string): void;
  discard(localId: string): void;
  recall(messageId: string, conversationId: string): Promise<void>;
  flash(text: string): void;
  describe(error: unknown): string;
};

const Ctx = createContext<AppStateValue | null>(null);

export function useApp() {
  const value = useContext(Ctx);
  if (!value) throw new Error("AppStateProvider missing");
  return value;
}

function outboxToLocal(item: OutboxItem, me: string): LocalMessage {
  return {
    id: item.localId,
    conversationId: item.conversationId,
    seq: 0,
    senderSub: me,
    type: item.type,
    body: item.body || item.file?.name || "",
    metadata: {},
    attachment: null,
    sourceProduct: "kkchat",
    recalledAt: null,
    createdAt: item.createdAt,
    read: false,
    clientMessageId: item.clientMessageId,
    localStatus: item.status === "failed" ? "failed" : "sending",
    localError: item.error,
  };
}

const PERMANENT = new Set([400, 403, 404, 409, 413]);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [phase, setPhase] = useState<Phase>("booting");
  const [accountSub, setAccountSub] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [client, setClient] = useState<KkchatClient | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [requests, setRequests] = useState<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>({ incoming: [], outgoing: [] });
  const [threads, setThreads] = useState<Record<string, ThreadState>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);

  /** 每次切换账号加一代。旧账号的异步结果回来时代号对不上，直接丢弃，不会显示到新账号下。 */
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const clientRef = useRef<KkchatClient | null>(null);
  const subRef = useRef<string | null>(null);
  const cursorRef = useRef(new SeqCursor(0));
  const realtimeRef = useRef<RealtimeConnection | null>(null);
  const viewingRef = useRef<string | null>(null);
  const outboxRef = useRef<OutboxItem[]>([]);
  const processingRef = useRef(false);
  const syncingRef = useRef(false);
  const mutedRef = useRef(new Set<string>());
  const hideContentRef = useRef(false);
  const localeRef = useRef<Locale>(locale);
  localeRef.current = locale;

  const t = useCallback((key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(localeRef.current, key, vars), []);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 3500);
  }, []);

  const describe = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) return error.status === 0 ? t("networkError") : error.message;
      if (error instanceof AuthError) {
        if (error.code === "network") return t("networkError");
        if (error.code === "reauth") return t("reauthRequired");
        if (error.code === "expired") return t("sessionExpired");
        if (error.code === "cancelled") return t("signInFailed");
      }
      return t("networkError");
    },
    [t],
  );

  const persistOutbox = useCallback((next: OutboxItem[]) => {
    outboxRef.current = next;
    setOutbox(next);
    if (subRef.current) writeAccountJson(subRef.current, "outbox", next);
  }, []);

  const loadInbox = useCallback(async () => {
    const gen = genRef.current;
    const api = clientRef.current;
    if (!api) return;
    const items = sortInbox(await api.inbox());
    if (gen !== genRef.current) return;
    mutedRef.current = new Set(items.filter((item) => item.muted).map((item) => item.id));
    setInbox(items);
    if (subRef.current) writeAccountJson(subRef.current, "inbox", items);
  }, []);

  const refreshContacts = useCallback(async () => {
    const gen = genRef.current;
    const api = clientRef.current;
    if (!api) return;
    const [list, pending] = await Promise.all([api.friends(), api.requests()]);
    if (gen !== genRef.current) return;
    setFriends(list);
    setRequests(pending);
  }, []);

  const loadThread = useCallback(async (conversationId: string) => {
    const gen = genRef.current;
    const api = clientRef.current;
    if (!api) return;
    const data = await api.thread(conversationId);
    if (gen !== genRef.current) return;
    setThreads((prev) => {
      const pendingLocal = (prev[conversationId]?.messages || []).filter((item) => item.localStatus);
      return {
        ...prev,
        [conversationId]: { messages: mergeMessages(pendingLocal, data.messages), hasMore: data.hasMore, participants: data.participants, loaded: true },
      };
    });
    setInbox((prev) => sortInbox(prev.some((item) => item.id === conversationId) ? prev.map((item) => (item.id === conversationId ? data.conversation : item)) : [data.conversation, ...prev]));
  }, []);

  const notifyLocally = useCallback(
    async (message: PublicMessage) => {
      if (AppState.currentState === "active" && viewingRef.current === message.conversationId) return;
      if (mutedRef.current.has(message.conversationId)) return;
      const prefs = await readPrefs();
      if (!prefs.notifications) return;
      const conversation = inboxRef.current.find((item) => item.id === message.conversationId);
      const title = conversation?.title || "KKChat";
      const body = hideContentRef.current
        ? t("newMessages", { count: 1 })
        : message.type === "IMAGE"
          ? `[${t("photo")}]`
          : message.type === "FILE"
            ? `[${t("file")}] ${message.body || ""}`
            : (message.body || "").slice(0, 120);
      if (AppState.currentState !== "active") {
        await Notifications.scheduleNotificationAsync({
          content: { title, body, data: { conversationId: message.conversationId, accountSub: subRef.current } },
          trigger: null,
        });
      }
    },
    [t],
  );

  const inboxRef = useRef<InboxItem[]>([]);
  inboxRef.current = inbox;

  const applyEvent = useCallback(
    (kind: string, conversationId: string | null, data: Record<string, unknown>) => {
      const mine = subRef.current;
      if (!mine) return;
      if (kind === "message" || kind === "recall") {
        const message = data as unknown as PublicMessage;
        setInbox((prev) => {
          if (!prev.some((item) => item.id === message.conversationId)) {
            void loadInbox().catch(() => undefined);
            return prev;
          }
          return bumpInbox(prev, message, mine, viewingRef.current);
        });
        setThreads((prev) => {
          const thread = prev[message.conversationId];
          if (!thread) return prev;
          return { ...prev, [message.conversationId]: { ...thread, messages: mergeMessages(thread.messages, [message]) } };
        });
        if (kind === "message" && message.senderSub !== mine) {
          if (viewingRef.current === message.conversationId && AppState.currentState === "active") {
            void clientRef.current?.markRead(message.conversationId, message.seq).catch(() => undefined);
          } else {
            void notifyLocally(message).catch(() => undefined);
          }
        }
        return;
      }
      if (kind === "read") {
        const reader = String(data.accountSub || "");
        const lastReadSeq = Number(data.lastReadSeq || 0);
        if (reader === mine) {
          setInbox((prev) => prev.map((item) => (item.id === conversationId ? { ...item, unreadCount: Number(data.unreadCount || 0), lastReadSeq } : item)));
        } else if (conversationId) {
          setThreads((prev) => {
            const thread = prev[conversationId];
            if (!thread) return prev;
            return { ...prev, [conversationId]: { ...thread, messages: applyPeerRead(thread.messages, mine, reader, lastReadSeq) } };
          });
        }
        return;
      }
      if (kind === "conversation") {
        void loadInbox().catch(() => undefined);
        if (conversationId && data.action === "access_changed") void loadThread(conversationId).catch(() => undefined);
        return;
      }
      if (kind === "friend" || kind === "request" || kind === "block") {
        void refreshContacts().catch(() => undefined);
        void loadInbox().catch(() => undefined);
      }
    },
    [loadInbox, loadThread, notifyLocally, refreshContacts],
  );

  const resync = useCallback(async () => {
    const gen = genRef.current;
    const api = clientRef.current;
    if (!api) return;
    const info = await api.me();
    if (gen !== genRef.current) return;
    setMe(info);
    await Promise.all([loadInbox(), refreshContacts()]);
    if (viewingRef.current) await loadThread(viewingRef.current).catch(() => undefined);
    cursorRef.current = new SeqCursor(info.syncSeq);
    if (subRef.current) writeAccountJson(subRef.current, "cursor", info.syncSeq);
  }, [loadInbox, loadThread, refreshContacts]);

  /** 按 seq 补拉。游标太旧或在服务器之前时，重新对齐全量状态。 */
  const catchUp = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    const gen = genRef.current;
    try {
      for (let guard = 0; guard < 20; guard += 1) {
        const api = clientRef.current;
        if (!api || gen !== genRef.current) return;
        const page = await api.sync(cursorRef.current.value);
        if (gen !== genRef.current) return;
        if (page.resyncRequired) {
          await resync();
          return;
        }
        for (const event of page.events) {
          if (cursorRef.current.accept(event.seq) === "new") applyEvent(event.kind, event.conversationId, event.data);
          else if (event.seq > cursorRef.current.value) cursorRef.current.value = event.seq;
        }
        if (subRef.current) writeAccountJson(subRef.current, "cursor", cursorRef.current.value);
        if (!page.hasMore) return;
      }
    } catch {
      // 补拉失败等下次连上再试。
    } finally {
      syncingRef.current = false;
    }
  }, [applyEvent, resync]);

  const processOutbox = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    const gen = genRef.current;
    try {
      for (;;) {
        const api = clientRef.current;
        if (!api || gen !== genRef.current) return;
        const item = outboxRef.current.find((entry) => entry.status === "pending");
        if (!item) return;
        persistOutbox(outboxRef.current.map((entry) => (entry.localId === item.localId ? { ...entry, status: "sending" } : entry)));
        try {
          let attachmentId = item.file?.attachmentId;
          if (item.file && !attachmentId) {
            const form = new FormData();
            form.append("file", { uri: item.file.uri, name: item.file.name, type: item.file.mimeType } as unknown as Blob);
            form.append("kind", item.file.kind);
            form.append("clientUploadId", item.clientMessageId);
            const uploaded = await api.upload(item.conversationId, form);
            attachmentId = uploaded.attachment.id;
            persistOutbox(
              outboxRef.current.map((entry) => (entry.localId === item.localId && entry.file ? { ...entry, file: { ...entry.file, attachmentId } } : entry)),
            );
          }
          const result = await api.send(item.conversationId, {
            body: item.file ? "" : item.body,
            type: item.type,
            clientMessageId: item.clientMessageId,
            attachmentId,
          });
          if (gen !== genRef.current) return;
          persistOutbox(outboxRef.current.filter((entry) => entry.localId !== item.localId));
          setThreads((prev) => {
            const thread = prev[item.conversationId];
            if (!thread) return prev;
            const withoutLocal = thread.messages.filter((message) => message.id !== item.localId);
            return { ...prev, [item.conversationId]: { ...thread, messages: mergeMessages(withoutLocal, [result.message]) } };
          });
          setInbox((prev) => bumpInbox(prev, result.message, subRef.current || "", viewingRef.current));
        } catch (error) {
          if (gen !== genRef.current) return;
          const permanent = error instanceof ApiError && PERMANENT.has(error.status);
          const next = outboxRef.current.map((entry) =>
            entry.localId === item.localId
              ? { ...entry, attempts: entry.attempts + 1, status: permanent ? ("failed" as const) : ("pending" as const), error: describe(error) }
              : entry,
          );
          persistOutbox(next);
          setThreads((prev) => {
            const thread = prev[item.conversationId];
            if (!thread) return prev;
            return {
              ...prev,
              [item.conversationId]: {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === item.localId ? { ...message, localStatus: "failed", localError: describe(error) } : message,
                ),
              },
            };
          });
          if (!permanent) return;
        }
      }
    } finally {
      processingRef.current = false;
    }
  }, [describe, persistOutbox]);

  const activate = useCallback(
    async (sub: string) => {
      genRef.current += 1;
      const gen = genRef.current;
      abortRef.current?.abort();
      realtimeRef.current?.stop();
      const controller = new AbortController();
      abortRef.current = controller;
      subRef.current = sub;
      viewingRef.current = null;
      setAccountSub(sub);
      setMe(null);
      setThreads({});
      setFriends([]);
      setRequests({ incoming: [], outgoing: [] });
      setInbox(await readAccountJson<InboxItem[]>(sub, "inbox", []));
      setDrafts(await readAccountJson<Record<string, string>>(sub, "drafts", {}));
      const savedOutbox = (await readAccountJson<OutboxItem[]>(sub, "outbox", [])).map((item) =>
        item.status === "sending" ? { ...item, status: "pending" as const } : item,
      );
      outboxRef.current = savedOutbox;
      setOutbox(savedOutbox);
      cursorRef.current = new SeqCursor(await readAccountJson<number>(sub, "cursor", 0));
      if (gen !== genRef.current) return;
      const api = createClient({
        baseUrl: API_BASE_URL,
        async headers() {
          return { authorization: `Bearer ${await accessToken(sub)}` };
        },
        async onUnauthorized() {
          try {
            await refreshSession(sub);
            return true;
          } catch {
            return false;
          }
        },
        fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }),
      });
      clientRef.current = api;
      setClient(api);
      setPhase("ready");
      const realtime = new RealtimeConnection(() => accessToken(sub), {
        onEvent: (kind, payload: RealtimePayload) => {
          if (gen !== genRef.current) return;
          const verdict = cursorRef.current.accept(payload.seq);
          if (verdict === "new") {
            applyEvent(kind, payload.conversationId, payload.data);
            writeAccountJson(sub, "cursor", cursorRef.current.value);
          } else if (verdict === "gap") {
            void catchUp();
          }
        },
        onReady: () => {
          if (gen !== genRef.current) return;
          void catchUp();
          void processOutbox();
        },
        onState: (state) => {
          if (gen === genRef.current) setConnection(state);
        },
        onRevoked: () => {
          if (gen !== genRef.current) return;
          flash(t("sessionRevoked"));
          void signOut(sub).then(async () => {
            const rest = await listAccounts();
            setAccounts(rest);
            if (rest[0]) await activateRef.current(rest[0].accountSub);
            else {
              clientRef.current = null;
              setClient(null);
              setPhase("signedOut");
            }
          });
        },
      });
      realtimeRef.current = realtime;
      realtime.start();
      try {
        await resync();
        void api
          .privacy()
          .then((privacy) => {
            hideContentRef.current = privacy.hideNotificationContent;
          })
          .catch(() => undefined);
      } catch (error) {
        if (error instanceof AuthError && error.code === "expired") {
          flash(t("sessionExpired"));
          await signOut(sub);
          const rest = await listAccounts();
          setAccounts(rest);
          if (rest[0] && rest[0].accountSub !== sub) await activateRef.current(rest[0].accountSub);
          else {
            clientRef.current = null;
            setClient(null);
            setPhase("signedOut");
          }
        }
      }
    },
    [applyEvent, catchUp, flash, processOutbox, resync, t],
  );
  const activateRef = useRef(activate);
  activateRef.current = activate;

  useEffect(() => {
    void (async () => {
      const list = await listAccounts();
      setAccounts(list);
      const current = await currentAccountSub();
      const sub = current && (await loadSession(current)) ? current : list[0]?.accountSub;
      if (sub && (await loadSession(sub))) await activateRef.current(sub);
      else setPhase("signedOut");
    })();
  }, []);

  useEffect(() => {
    const appSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        realtimeRef.current?.kick();
        void catchUp();
      }
    });
    const netSub = NetInfo.addEventListener((info) => {
      if (info.isConnected) {
        realtimeRef.current?.kick();
        void processOutbox();
      } else {
        setConnection("offline");
      }
    });
    return () => {
      appSub.remove();
      netSub();
    };
  }, [catchUp, processOutbox]);

  useEffect(() => {
    if (me && accountSub) {
      void updateAccountSummary({ accountSub, displayName: me.displayName, kkNumber: me.kkNumber, avatarUrl: me.avatarUrl }).then(() =>
        listAccounts().then(setAccounts),
      );
    }
  }, [accountSub, me]);

  const value = useMemo<AppStateValue>(
    () => ({
      phase,
      accountSub,
      me,
      accounts,
      client,
      inbox,
      friends,
      requests,
      threads,
      drafts,
      outbox,
      connection,
      notice,
      pendingLink,
      setPendingLink,
      flash,
      describe,
      async signInFlow(options) {
        const { account } = await signIn({ prompt: options?.prompt, locale: localeRef.current });
        setAccounts(await listAccounts());
        await activate(account.accountSub);
      },
      async switchAccount(sub) {
        if (sub === subRef.current) return;
        if (!(await loadSession(sub))) {
          const { account } = await signIn({ prompt: "login", locale: localeRef.current });
          setAccounts(await listAccounts());
          await activate(account.accountSub);
          return;
        }
        await setCurrentAccount(sub);
        await activate(sub);
      },
      async signOutCurrent() {
        const sub = subRef.current;
        if (!sub) return;
        genRef.current += 1;
        realtimeRef.current?.stop();
        abortRef.current?.abort();
        if (Platform.OS !== "web") await Notifications.dismissAllNotificationsAsync().catch(() => undefined);
        await signOut(sub);
        const rest = await listAccounts();
        setAccounts(rest);
        if (rest[0]) await activate(rest[0].accountSub);
        else {
          subRef.current = null;
          clientRef.current = null;
          setClient(null);
          setAccountSub(null);
          setMe(null);
          setInbox([]);
          setThreads({});
          setPhase("signedOut");
        }
      },
      refreshAll: resync,
      refreshContacts,
      async openThread(conversationId) {
        await loadThread(conversationId);
      },
      async loadEarlier(conversationId) {
        const api = clientRef.current;
        const thread = threads[conversationId];
        const first = thread?.messages.find((item) => !item.localStatus);
        if (!api || !first) return;
        const gen = genRef.current;
        const page = await api.messages(conversationId, { beforeSeq: first.seq, limit: 50 });
        if (gen !== genRef.current) return;
        setThreads((prev) => {
          const current = prev[conversationId];
          if (!current) return prev;
          return { ...prev, [conversationId]: { ...current, messages: mergeMessages(current.messages, page.messages), hasMore: page.hasMore } };
        });
      },
      setViewing(conversationId) {
        viewingRef.current = conversationId;
        if (conversationId) void clientRef.current?.presence(conversationId).catch(() => undefined);
      },
      markRead(conversationId) {
        const thread = threads[conversationId];
        const last = thread?.messages.filter((item) => !item.localStatus).at(-1);
        if (!last || AppState.currentState !== "active") return;
        const item = inbox.find((entry) => entry.id === conversationId);
        if (item && item.lastReadSeq >= last.seq && item.unreadCount === 0) return;
        void clientRef.current
          ?.markRead(conversationId, last.seq)
          .then((result) =>
            setInbox((prev) => prev.map((entry) => (entry.id === conversationId ? { ...entry, unreadCount: result.unreadCount, lastReadSeq: result.lastReadSeq } : entry))),
          )
          .catch(() => undefined);
      },
      setDraft(conversationId, text) {
        setDrafts((prev) => {
          const next = { ...prev, [conversationId]: text };
          if (!text) delete next[conversationId];
          if (subRef.current) writeAccountJson(subRef.current, "drafts", next);
          return next;
        });
      },
      sendText(conversationId, text) {
        const body = text.trim();
        const sub = subRef.current;
        if (!body || !sub) return;
        const clientMessageId = newClientId();
        const item: OutboxItem = {
          localId: `local-${clientMessageId}`,
          conversationId,
          clientMessageId,
          type: "TEXT",
          body,
          createdAt: new Date().toISOString(),
          attempts: 0,
          status: "pending",
        };
        persistOutbox([...outboxRef.current, item]);
        setThreads((prev) => {
          const thread = prev[conversationId] || { messages: [], hasMore: false, participants: [], loaded: false };
          return { ...prev, [conversationId]: { ...thread, messages: [...thread.messages, outboxToLocal(item, sub)] } };
        });
        void processOutbox();
      },
      sendFile(conversationId, file) {
        const sub = subRef.current;
        if (!sub) return;
        const clientMessageId = newClientId();
        const item: OutboxItem = {
          localId: `local-${clientMessageId}`,
          conversationId,
          clientMessageId,
          type: file.kind === "image" ? "IMAGE" : "FILE",
          body: file.name,
          file,
          createdAt: new Date().toISOString(),
          attempts: 0,
          status: "pending",
        };
        persistOutbox([...outboxRef.current, item]);
        setThreads((prev) => {
          const thread = prev[conversationId] || { messages: [], hasMore: false, participants: [], loaded: false };
          return { ...prev, [conversationId]: { ...thread, messages: [...thread.messages, outboxToLocal(item, sub)] } };
        });
        void processOutbox();
      },
      retry(localId) {
        persistOutbox(outboxRef.current.map((entry) => (entry.localId === localId ? { ...entry, status: "pending", error: undefined } : entry)));
        setThreads((prev) => {
          const next = { ...prev };
          for (const [id, thread] of Object.entries(prev)) {
            if (thread.messages.some((message) => message.id === localId)) {
              next[id] = { ...thread, messages: thread.messages.map((message) => (message.id === localId ? { ...message, localStatus: "sending", localError: undefined } : message)) };
            }
          }
          return next;
        });
        void processOutbox();
      },
      discard(localId) {
        persistOutbox(outboxRef.current.filter((entry) => entry.localId !== localId));
        setThreads((prev) => {
          const next = { ...prev };
          for (const [id, thread] of Object.entries(prev)) {
            next[id] = { ...thread, messages: thread.messages.filter((message) => message.id !== localId) };
          }
          return next;
        });
      },
      async recall(messageId, conversationId) {
        const api = clientRef.current;
        if (!api) return;
        const result = await api.recall(messageId);
        setThreads((prev) => {
          const thread = prev[conversationId];
          if (!thread) return prev;
          return { ...prev, [conversationId]: { ...thread, messages: mergeMessages(thread.messages, [result.message]) } };
        });
      },
    }),
    [accountSub, accounts, activate, client, connection, describe, drafts, flash, friends, inbox, loadThread, me, notice, outbox, pendingLink, persistOutbox, phase, processOutbox, refreshContacts, requests, resync, threads],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOutboxMessages(conversationId: string): LocalMessage[] {
  const { outbox, accountSub } = useApp();
  return useMemo(
    () => outbox.filter((item) => item.conversationId === conversationId).map((item) => outboxToLocal(item, accountSub || "")),
    [accountSub, conversationId, outbox],
  );
}
