"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, newClientId } from "@shared/client";
import { formatMessageTime, type MessageKey } from "@shared/i18n";
import { applyPeerRead, bumpInbox, mergeMessages, SeqCursor, sortInbox } from "@shared/merge";
import type {
  FriendRequestView,
  FriendView,
  InboxItem,
  LocalMessage,
  Participant,
  PublicMessage,
  PublicUser,
  Relationship,
} from "@shared/types";
import type { CurrentUser } from "@/lib/current-user";
import { AddFriendModal, QrModal, ReportModal, type ReportTarget } from "./friend-modals";
import { useI18n } from "./i18n";
import { MePanel } from "./me-panel";
import { webClient as api } from "./web-client";

type Tab = "chats" | "contacts" | "me";
type Connection = "online" | "reconnecting" | "offline";

export function ChatShell({ me, initialConversationId, initialTab = "chats" }: { me: CurrentUser; initialConversationId: string; initialTab?: Tab }) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [chatFilter, setChatFilter] = useState("");
  const [activeId, setActiveId] = useState(initialConversationId);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [requests, setRequests] = useState<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>({ incoming: [], outgoing: [] });
  const [friendFilter, setFriendFilter] = useState("");
  const [profileSub, setProfileSub] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [draft, setDraft] = useState("");
  const [connection, setConnection] = useState<Connection>("online");
  const [toast, setToast] = useState("");
  const [unseen, setUnseen] = useState(0);
  const [moderator, setModerator] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const activeRef = useRef(activeId);
  const cursorRef = useRef(new SeqCursor(0));
  const syncingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const cursorKey = `kkchat.cursor.${me.accountSub}`;

  const active = inbox.find((item) => item.id === activeId) || null;
  const paneSub = profileSub ?? (active?.kind === "DIRECT" ? active.peer?.accountSub ?? null : null);
  const paneSubRef = useRef(paneSub);
  const shownRelationship = relationship && paneSub && relationship.peer.accountSub === paneSub ? relationship : null;

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    paneSubRef.current = paneSub;
  }, [paneSub]);

  const flash = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 3200);
  }, []);

  const describe = useCallback(
    (error: unknown) => (error instanceof ApiError ? (error.status === 0 ? t("networkError") : error.message) : t("networkError")),
    [t],
  );

  const loadInbox = useCallback(async () => setInbox(sortInbox(await api.inbox())), []);
  const loadContacts = useCallback(async () => {
    const [list, pending] = await Promise.all([api.friends(), api.requests()]);
    setFriends(list);
    setRequests(pending);
  }, []);

  const loadThread = useCallback(async (id: string) => {
    const data = await api.thread(id);
    if (activeRef.current !== id) return;
    setMessages((prev) => mergeMessages(prev.filter((item) => item.conversationId === id && item.localStatus), data.messages));
    setHasMore(data.hasMore);
    setParticipants(data.participants);
    setInbox((prev) => sortInbox(prev.some((item) => item.id === id) ? prev.map((item) => (item.id === id ? data.conversation : item)) : [data.conversation, ...prev]));
    const last = data.messages.at(-1);
    if (last && document.visibilityState === "visible") {
      const read = await api.markRead(id, last.seq).catch(() => null);
      if (read) setInbox((prev) => prev.map((item) => (item.id === id ? { ...item, unreadCount: read.unreadCount, lastReadSeq: read.lastReadSeq } : item)));
    }
  }, []);

  const loadRelationship = useCallback(async (sub: string) => {
    setRelationship(await api.relationship(sub));
  }, []);

  /** 全量重新对齐：游标过旧或首次进入时用。 */
  const resync = useCallback(async () => {
    const meInfo = await api.me();
    setModerator(meInfo.moderator);
    await Promise.all([loadInbox(), loadContacts()]);
    if (activeRef.current) await loadThread(activeRef.current).catch(() => undefined);
    cursorRef.current = new SeqCursor(meInfo.syncSeq);
    localStorage.setItem(cursorKey, String(meInfo.syncSeq));
  }, [cursorKey, loadContacts, loadInbox, loadThread]);

  const applyEvent = useCallback(
    (kind: string, conversationId: string | null, data: Record<string, unknown>) => {
      if (kind === "message" || kind === "recall") {
        const message = data as unknown as PublicMessage;
        setInbox((prev) => {
          if (!prev.some((item) => item.id === message.conversationId)) {
            void loadInbox();
            return prev;
          }
          return bumpInbox(prev, message, me.accountSub, activeRef.current);
        });
        if (message.conversationId === activeRef.current) {
          setMessages((prev) => mergeMessages(prev, [message]));
          if (kind === "message" && message.senderSub !== me.accountSub) {
            if (stickRef.current && document.visibilityState === "visible") {
              void api.markRead(message.conversationId, message.seq).catch(() => undefined);
            } else {
              setUnseen((count) => count + 1);
            }
          }
        }
        return;
      }
      if (kind === "read") {
        const reader = String(data.accountSub || "");
        const lastReadSeq = Number(data.lastReadSeq || 0);
        if (reader === me.accountSub) {
          setInbox((prev) => prev.map((item) => (item.id === conversationId ? { ...item, unreadCount: Number(data.unreadCount || 0), lastReadSeq } : item)));
        } else if (conversationId === activeRef.current) {
          setMessages((prev) => applyPeerRead(prev, me.accountSub, reader, lastReadSeq));
        }
        return;
      }
      if (kind === "conversation") {
        void loadInbox();
        if (conversationId && conversationId === activeRef.current && data.action === "access_changed") void loadThread(conversationId);
        return;
      }
      if (kind === "friend" || kind === "request" || kind === "block") {
        void loadContacts();
        void loadInbox();
        if (paneSubRef.current) void loadRelationship(paneSubRef.current).catch(() => undefined);
      }
    },
    [loadContacts, loadInbox, loadRelationship, loadThread, me.accountSub],
  );

  /** 断线、重连、跳号时按 seq 补拉；重复事件按 seq 丢弃。 */
  const catchUp = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await api.sync(cursorRef.current.value);
        if (page.resyncRequired) {
          await resync();
          break;
        }
        for (const event of page.events) {
          if (cursorRef.current.accept(event.seq) === "new") applyEvent(event.kind, event.conversationId, event.data);
          else if (event.seq > cursorRef.current.value) cursorRef.current.value = event.seq;
        }
        localStorage.setItem(cursorKey, String(cursorRef.current.value));
        if (!page.hasMore) break;
      }
    } finally {
      syncingRef.current = false;
    }
  }, [applyEvent, cursorKey, resync]);

  useEffect(() => {
    const saved = Number(localStorage.getItem(cursorKey) || "0");
    // 首次进入先全量拉取再接实时；挂载后才发请求。
    void (saved > 0 ? Promise.all([loadInbox(), loadContacts(), api.me().then((info) => setModerator(info.moderator))]).then(() => {
      cursorRef.current = new SeqCursor(saved);
    }) : resync()).catch(() => setConnection("offline"));
  }, [cursorKey, loadContacts, loadInbox, resync]);

  useEffect(() => {
    if (!activeId) return;
    setUnseen(0);
    stickRef.current = true;
    // 切换会话时取消息。失败则回到列表。
    void loadThread(activeId).catch(() => setActiveId(""));
    const ping = () => void api.presence(activeId).catch(() => undefined);
    ping();
    const timer = window.setInterval(ping, 20_000);
    return () => window.clearInterval(timer);
  }, [activeId, loadThread]);

  useEffect(() => {
    if (!paneSub) return;
    // 资料栏显示的人一变就拉关系状态；桌面宽屏时默认是当前单聊对象。
    void loadRelationship(paneSub).catch((error) => flash(describe(error)));
  }, [describe, flash, loadRelationship, paneSub]);

  useEffect(() => {
    const tabContext = (window as Window & { __yydsTabContext?: () => string }).__yydsTabContext?.() || "";
    let source: EventSource | null = null;
    let stopped = false;
    const open = () => {
      if (stopped) return;
      source = new EventSource(tabContext ? `/api/realtime?tab=${encodeURIComponent(tabContext)}` : "/api/realtime");
      const handle = (kind: string) => (event: MessageEvent) => {
        const payload = JSON.parse(event.data) as { seq: number; conversationId: string | null; data: Record<string, unknown> };
        const verdict = cursorRef.current.accept(payload.seq);
        if (verdict === "new") {
          applyEvent(kind, payload.conversationId, payload.data);
          localStorage.setItem(cursorKey, String(cursorRef.current.value));
        } else if (verdict === "gap") {
          void catchUp();
        }
      };
      for (const kind of ["message", "recall", "read", "conversation", "friend", "request", "block"]) {
        source.addEventListener(kind, handle(kind) as EventListener);
      }
      source.addEventListener("ready", () => {
        setConnection("online");
        void catchUp();
      });
      source.addEventListener("session", () => {
        stopped = true;
        source?.close();
        window.location.replace(`${window.location.origin}/?error=session-revoked`);
      });
      source.onerror = () => setConnection(navigator.onLine ? "reconnecting" : "offline");
    };
    open();
    const onOnline = () => {
      setConnection("reconnecting");
      void catchUp();
    };
    const onOffline = () => setConnection("offline");
    const onVisible = () => {
      if (document.visibilityState === "visible") void catchUp();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      source?.close();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyEvent, catchUp, cursorKey]);

  useEffect(() => {
    if (!stickRef.current) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, activeId]);

  const unreadTotal = useMemo(() => inbox.reduce((sum, item) => sum + (item.muted ? 0 : item.unreadCount), 0), [inbox]);
  const filteredInbox = useMemo(() => {
    const keyword = chatFilter.trim().toLowerCase();
    if (!keyword) return inbox;
    return inbox.filter((item) => `${item.title} ${item.peer?.kkNumber ?? ""} ${item.peer?.username ?? ""}`.toLowerCase().includes(keyword));
  }, [chatFilter, inbox]);
  const filteredFriends = useMemo(() => {
    const keyword = friendFilter.trim().toLowerCase();
    if (!keyword) return friends;
    return friends.filter((item) => `${item.remark} ${item.peer.displayName} ${item.peer.kkNumber ?? ""} ${item.peer.username ?? ""}`.toLowerCase().includes(keyword));
  }, [friendFilter, friends]);

  function openConversation(id: string) {
    setTab("chats");
    setActiveId(id);
    setShowProfile(false);
    setProfileSub(null);
    window.history.replaceState(null, "", `/app/conversations/${id}`);
  }

  async function openProfile(sub: string) {
    setProfileSub(sub);
    setShowProfile(true);
  }

  async function startChat(sub: string) {
    try {
      const { conversationId } = await api.openDirect(sub);
      await loadInbox();
      openConversation(conversationId);
    } catch (error) {
      flash(describe(error));
    }
  }

  async function deliver(local: LocalMessage, payload: { body: string; type: "TEXT" | "IMAGE" | "FILE"; attachmentId?: string }) {
    try {
      const data = await api.send(local.conversationId, { ...payload, clientMessageId: local.clientMessageId! });
      setMessages((prev) => mergeMessages(prev, [data.message]));
      setInbox((prev) => bumpInbox(prev, data.message, me.accountSub, activeRef.current));
    } catch (error) {
      setMessages((prev) =>
        prev.map((item) => (item.id === local.id ? { ...item, localStatus: "failed", localError: describe(error) } : item)),
      );
    }
  }

  function optimistic(conversationId: string, type: "TEXT" | "IMAGE" | "FILE", body: string): LocalMessage {
    const clientMessageId = newClientId();
    return {
      id: `local-${clientMessageId}`,
      conversationId,
      seq: 0,
      senderSub: me.accountSub,
      type,
      body,
      metadata: {},
      attachment: null,
      sourceProduct: "kkchat",
      recalledAt: null,
      createdAt: new Date().toISOString(),
      read: false,
      clientMessageId,
      localStatus: "sending",
    };
  }

  async function sendText() {
    const text = draft.trim();
    if (!text || !activeId) return;
    const local = optimistic(activeId, "TEXT", text);
    setMessages((prev) => [...prev, local]);
    setDraft("");
    stickRef.current = true;
    await deliver(local, { body: text, type: "TEXT" });
  }

  async function sendFile(file: File, kind: "image" | "file") {
    if (!activeId) return;
    const type = kind === "image" ? "IMAGE" : "FILE";
    const local = optimistic(activeId, type, file.name);
    setMessages((prev) => [...prev, local]);
    stickRef.current = true;
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      form.set("clientUploadId", local.clientMessageId!);
      const uploaded = await api.upload(activeId, form);
      await deliver(local, { body: "", type, attachmentId: uploaded.attachment.id });
    } catch (error) {
      setMessages((prev) => prev.map((item) => (item.id === local.id ? { ...item, localStatus: "failed", localError: describe(error) } : item)));
      pendingFiles.current.set(local.id, { file, kind });
    }
  }

  const pendingFiles = useRef(new Map<string, { file: File; kind: "image" | "file" }>());

  async function retry(message: LocalMessage) {
    setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, localStatus: "sending", localError: undefined } : item)));
    const file = pendingFiles.current.get(message.id);
    if (file) {
      pendingFiles.current.delete(message.id);
      setMessages((prev) => prev.filter((item) => item.id !== message.id));
      await sendFile(file.file, file.kind);
      return;
    }
    await deliver(message, { body: message.body || "", type: "TEXT" });
  }

  async function loadEarlier() {
    if (!activeId) return;
    const first = messages.find((item) => !item.localStatus);
    if (!first) return;
    const node = scroller.current;
    const before = node ? node.scrollHeight - node.scrollTop : 0;
    stickRef.current = false;
    const page = await api.messages(activeId, { beforeSeq: first.seq, limit: 50 });
    setMessages((prev) => mergeMessages(prev, page.messages));
    setHasMore(page.hasMore);
    requestAnimationFrame(() => {
      if (node) node.scrollTop = node.scrollHeight - before;
    });
  }

  async function recall(id: string) {
    try {
      const data = await api.recall(id);
      setMessages((prev) => mergeMessages(prev, [data.message]));
    } catch (error) {
      flash(describe(error));
    }
  }

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    try {
      await fn();
      after?.();
      await Promise.all([loadContacts(), loadInbox()]);
      if (paneSub) await loadRelationship(paneSub);
    } catch (error) {
      flash(describe(error));
    }
  }

  const relationBanner: MessageKey | null =
    active && !active.canSend ? (active.relation === "blocked_by_me" ? "blockedBanner" : active.kind === "DIRECT" ? "notFriendBanner" : "cannotSendHere") : null;

  return (
    <div className={`shell tab-${tab}${activeId && tab === "chats" ? " thread-open" : ""}${showProfile ? " show-profile" : ""}`}>
      <aside className="pane list-pane">
        <div className="pane-head">
          <Link href="/" className="wordmark">
            <span className="mark">KK</span>
            <strong>KKChat</strong>
          </Link>
          <nav className="tabs" aria-label="KKChat">
            {(["chats", "contacts", "me"] as const).map((item) => (
              <button key={item} type="button" className={tab === item ? "on" : ""} onClick={() => setTab(item)}>
                {t(item === "chats" ? "tabChats" : item === "contacts" ? "tabContacts" : "tabMe")}
                {item === "chats" && unreadTotal > 0 ? <span className="badge">{unreadTotal > 99 ? "99+" : unreadTotal}</span> : null}
                {item === "contacts" && requests.incoming.length > 0 ? <span className="badge">{requests.incoming.length}</span> : null}
              </button>
            ))}
          </nav>
        </div>
        {connection !== "online" ? <p className="conn">{t(connection === "offline" ? "offlineBanner" : "reconnecting")}</p> : null}

        {tab === "chats" ? (
          <>
            <div className="search">
              <input value={chatFilter} placeholder={t("searchChats")} aria-label={t("searchChats")} onChange={(event) => setChatFilter(event.target.value)} />
            </div>
            <div className="list">
              {filteredInbox.length === 0 ? <p className="empty">{t("noChats")}</p> : null}
              {filteredInbox.map((item) => (
                <button key={item.id} type="button" className={`conv${item.id === activeId ? " active" : ""}`} onClick={() => openConversation(item.id)}>
                  <Avatar name={item.title} url={item.avatarUrl} />
                  <span>
                    <b>
                      {item.title}
                      {item.pinned ? <em className="tag">{t("pinned")}</em> : null}
                      {item.sourceProduct !== "kkchat" ? <em className="tag">{t("fromProduct", { product: item.sourceProduct })}</em> : null}
                    </b>
                    <small>{item.lastMessagePreview || "…"}</small>
                  </span>
                  <span className="conv-meta">
                    <small>{formatMessageTime(item.lastMessageAt, locale)}</small>
                    {item.unreadCount > 0 ? <span className={`badge${item.muted ? " muted-badge" : ""}`}>{item.unreadCount}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {tab === "contacts" ? (
          <div className="list contacts">
            <div className="row-actions">
              <button className="btn btn-primary" type="button" onClick={() => setShowAdd(true)}>{t("addFriend")}</button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowQr(true)}>{t("myQr")}</button>
            </div>
            {requests.incoming.length > 0 ? <h3>{t("incomingRequests")}</h3> : null}
            {requests.incoming.map((request) => (
              <div className="req" key={request.id}>
                <button type="button" className="req-who" onClick={() => void openProfile(request.peer.accountSub)}>
                  <Avatar name={request.peer.displayName} url={request.peer.avatarUrl} />
                  <span>
                    <b>{request.peer.displayName}</b>
                    <small>{request.message || peerLine(request.peer, t)}</small>
                  </span>
                </button>
                <div className="req-actions">
                  <button className="btn btn-primary" type="button" onClick={() => void act(() => api.respond(request.id, "accept"))}>{t("accept")}</button>
                  <button className="btn btn-ghost" type="button" onClick={() => void act(() => api.respond(request.id, "reject"))}>{t("reject")}</button>
                </div>
              </div>
            ))}
            {requests.outgoing.length > 0 ? <h3>{t("outgoingRequests")}</h3> : null}
            {requests.outgoing.map((request) => (
              <div className="req" key={request.id}>
                <button type="button" className="req-who" onClick={() => void openProfile(request.peer.accountSub)}>
                  <Avatar name={request.peer.displayName} url={request.peer.avatarUrl} />
                  <span>
                    <b>{request.peer.displayName}</b>
                    <small>{t("requestSent")}</small>
                  </span>
                </button>
                <div className="req-actions">
                  <button className="btn btn-ghost" type="button" onClick={() => void act(() => api.respond(request.id, "cancel"))}>{t("withdraw")}</button>
                </div>
              </div>
            ))}
            <h3>{t("friends")}</h3>
            <div className="search flush">
              <input value={friendFilter} placeholder={t("filterFriends")} aria-label={t("filterFriends")} onChange={(event) => setFriendFilter(event.target.value)} />
            </div>
            {filteredFriends.length === 0 ? <p className="empty">{t("noFriends")}</p> : null}
            {filteredFriends.map((friend) => (
              <button key={friend.peer.accountSub} type="button" className="conv" onClick={() => void openProfile(friend.peer.accountSub)}>
                <Avatar name={friend.remark || friend.peer.displayName} url={friend.peer.avatarUrl} />
                <span>
                  <b>{friend.remark || friend.peer.displayName}</b>
                  <small>{peerLine(friend.peer, t)}</small>
                </span>
                <span />
              </button>
            ))}
          </div>
        ) : null}

        {tab === "me" ? <MePanel me={me} moderator={moderator} onShowQr={() => setShowQr(true)} onChanged={() => void act(async () => undefined)} /> : null}
      </aside>

      <section className="pane thread">
        {active && tab === "chats" ? (
          <>
            <div className="pane-head">
              <button className="text-btn back-link" type="button" onClick={() => setActiveId("")}>{t("back")}</button>
              <div className="thread-title">
                <b>{active.title}</b>
                <div className="muted">
                  {active.kind === "DIRECT" ? peerLine(active.peer, t) : t("members", { count: participants.length })}
                </div>
              </div>
              <div className="head-actions">
                <button className="text-btn" type="button" onClick={() => void api.setPrefs(active.id, { pinned: !active.pinned }).then(loadInbox)}>
                  {t(active.pinned ? "unpin" : "pin")}
                </button>
                <button className="text-btn" type="button" onClick={() => void api.setPrefs(active.id, { muted: !active.muted }).then(loadInbox)}>
                  {t(active.muted ? "unmute" : "mute")}
                </button>
                <button
                  className="text-btn"
                  type="button"
                  onClick={() => {
                    if (active.peer) void openProfile(active.peer.accountSub);
                    else setShowProfile(true);
                  }}
                >
                  {t("profile")}
                </button>
              </div>
            </div>
            <div
              className="messages"
              ref={scroller}
              onScroll={(event) => {
                const node = event.currentTarget;
                const near = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
                stickRef.current = near;
                if (near && unseen > 0) {
                  setUnseen(0);
                  const last = messages.filter((item) => !item.localStatus).at(-1);
                  if (last) void api.markRead(active.id, last.seq).catch(() => undefined);
                }
              }}
            >
              {hasMore ? (
                <button className="jump subtle" type="button" onClick={() => void loadEarlier()}>{t("loadEarlier")}</button>
              ) : messages.length > 30 ? (
                <p className="muted center">{t("noMoreMessages")}</p>
              ) : null}
              {messages.map((message) => {
                const mine = message.senderSub === me.accountSub;
                const sender = participants.find((item) => item.accountSub === message.senderSub);
                const fresh = !message.recalledAt && Date.now() - Date.parse(message.createdAt) < 2 * 60 * 1000;
                return (
                  <article key={message.id} className={`msg${mine ? " mine" : " theirs"}`}>
                    <Avatar name={mine ? me.displayName : sender?.displayName || active.title} url={mine ? me.avatarUrl : sender?.avatarUrl || ""} />
                    <div className="bubble-wrap">
                      {!mine && active.kind !== "DIRECT" ? <small className="muted">{sender?.displayName || "…"}</small> : null}
                      <MessageBody message={message} />
                      <div className="meta">
                        <span>{formatMessageTime(message.createdAt, locale)}</span>
                        {message.localStatus === "sending" ? <span>{t("sending")}</span> : null}
                        {message.localStatus === "failed" ? (
                          <button className="link-btn danger" type="button" title={message.localError} onClick={() => void retry(message)}>
                            {t("failed")} · {t("tapToRetry")}
                          </button>
                        ) : null}
                        {mine && !message.localStatus && !message.recalledAt && active.kind === "DIRECT" ? <span>{t(message.read ? "read" : "unread")}</span> : null}
                        {mine && fresh && !message.localStatus ? (
                          <button className="link-btn" type="button" onClick={() => void recall(message.id)}>{t("recall")}</button>
                        ) : null}
                        {!mine && !message.recalledAt && !message.localStatus ? (
                          <button
                            className="link-btn"
                            type="button"
                            onClick={() => setReportTarget({ targetSub: message.senderSub, messageId: message.id, name: sender?.displayName || active.title })}
                          >
                            {t("report")}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
              {unseen > 0 ? (
                <button
                  className="jump"
                  type="button"
                  onClick={() => {
                    stickRef.current = true;
                    setUnseen(0);
                    const node = scroller.current;
                    if (node) node.scrollTop = node.scrollHeight;
                  }}
                >
                  {t("newMessages", { count: unseen })}
                </button>
              ) : null}
            </div>
            {relationBanner ? (
              <div className="banner">
                <span>{t(relationBanner)}</span>
                {active.peer && active.relation === "not_friends" ? (
                  <button className="btn btn-ghost" type="button" onClick={() => void openProfile(active.peer!.accountSub)}>{t("addFriend")}</button>
                ) : null}
              </div>
            ) : (
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendText();
                }}
              >
                <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void sendFile(file, "image");
                }} />
                <input ref={fileInput} type="file" hidden onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void sendFile(file, "file");
                }} />
                <button className="icon-btn" type="button" aria-label={t("photo")} title={t("photo")} onClick={() => imageInput.current?.click()}>🖼</button>
                <button className="icon-btn" type="button" aria-label={t("file")} title={t("file")} onClick={() => fileInput.current?.click()}>📎</button>
                <textarea
                  value={draft}
                  aria-label={t("typeMessage")}
                  placeholder={t("typeMessage")}
                  rows={1}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                    if (window.matchMedia("(max-width: 800px)").matches) return;
                    event.preventDefault();
                    void sendText();
                  }}
                />
                <button className="btn btn-primary" type="submit">{t("send")}</button>
              </form>
            )}
          </>
        ) : (
          <div className="empty">
            <p>{t("tagline")}</p>
          </div>
        )}
      </section>

      <aside className="pane profile-pane">
        <div className="profile-head">
          <button className="text-btn back-link always" type="button" onClick={() => { setShowProfile(false); setProfileSub(null); }}>{t("back")}</button>
          <b>{t("profile")}</b>
        </div>
        <div className="profile">
          {shownRelationship ? (
            <ProfileCard
              key={shownRelationship.peer.accountSub}
              relationship={shownRelationship}
              onMessage={() => void startChat(shownRelationship.peer.accountSub)}
              onRequest={(message) =>
                void act(() => api.sendRequest({ addresseeSub: shownRelationship.peer.accountSub, message, source: "profile", clientRequestId: newClientId() }))
              }
              onAccept={() => shownRelationship.incoming && void act(() => api.respond(shownRelationship.incoming!.id, "accept"))}
              onReject={() => shownRelationship.incoming && void act(() => api.respond(shownRelationship.incoming!.id, "reject"))}
              onWithdraw={() => shownRelationship.outgoing && void act(() => api.respond(shownRelationship.outgoing!.id, "cancel"))}
              onRemark={(remark) => void act(() => api.setRemark(shownRelationship.peer.accountSub, remark))}
              onDelete={() => {
                if (window.confirm(t("deleteFriendConfirm"))) void act(() => api.removeFriend(shownRelationship.peer.accountSub));
              }}
              onBlock={() => {
                if (window.confirm(t("blockConfirm"))) void act(() => api.block(shownRelationship.peer.accountSub));
              }}
              onUnblock={() => void act(() => api.unblock(shownRelationship.peer.accountSub))}
              onReport={() => setReportTarget({ targetSub: shownRelationship.peer.accountSub, name: shownRelationship.peer.displayName, conversationId: shownRelationship.conversationId || undefined })}
            />
          ) : paneSub ? (
            <p className="muted">{t("loading")}</p>
          ) : active && active.kind !== "DIRECT" ? (
            <>
              <b>{active.title}</b>
              <p className="muted">{t("members", { count: participants.length })}</p>
              {participants.map((member) => (
                <button key={member.accountSub} type="button" className="conv" onClick={() => member.accountSub !== me.accountSub && void openProfile(member.accountSub)}>
                  <Avatar name={member.displayName} url={member.avatarUrl} />
                  <span>
                    <b>{member.displayName}</b>
                    <small>{peerLine(member, t)}</small>
                  </span>
                  <span />
                </button>
              ))}
            </>
          ) : (
            <p className="muted">{t("profileHint")}</p>
          )}
        </div>
      </aside>

      {showAdd ? (
        <AddFriendModal
          meName={me.displayName}
          onClose={() => setShowAdd(false)}
          onOpenProfile={(sub) => {
            setShowAdd(false);
            void openProfile(sub);
          }}
          onChanged={() => void act(async () => undefined)}
        />
      ) : null}
      {showQr ? <QrModal onClose={() => setShowQr(false)} /> : null}
      {reportTarget ? <ReportModal target={reportTarget} onClose={() => setReportTarget(null)} onDone={() => flash(t("reportSubmitted"))} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}

function peerLine(peer: PublicUser | null, t: (key: MessageKey, vars?: Record<string, string | number>) => string) {
  if (!peer) return "";
  const parts = [];
  if (peer.kkNumber) parts.push(`${t("kkNumber")} ${peer.kkNumber}`);
  if (peer.username) parts.push(`@${peer.username}`);
  return parts.join(" · ");
}

function MessageBody({ message }: { message: LocalMessage }) {
  const { t } = useI18n();
  if (message.recalledAt) return <div className="bubble recalled">{t("recalled")}</div>;
  if (message.type === "IMAGE" && message.attachment) {
    const url = `/api/attachments/${encodeURIComponent(message.attachment.id)}`;
    return (
      <a className="bubble media" href={url} target="_blank" rel="noopener noreferrer">
        {/* 私有附件经过会话成员校验返回，不能交给构建期图片优化。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={message.attachment.name} loading="lazy" />
      </a>
    );
  }
  if (message.type === "FILE" && message.attachment) {
    const url = `/api/attachments/${encodeURIComponent(message.attachment.id)}`;
    return (
      <a className="bubble file" href={url} rel="noopener noreferrer">
        📄 {message.attachment.name} <small>{formatSize(message.attachment.size)}</small>
      </a>
    );
  }
  if ((message.type === "IMAGE" || message.type === "FILE") && message.localStatus) {
    return <div className="bubble">{message.type === "IMAGE" ? "🖼" : "📄"} {message.body}</div>;
  }
  if (message.type === "ACTION_CARD" || message.type === "SYSTEM") return <div className="bubble system">{message.body}</div>;
  return <div className="bubble">{message.body}</div>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ProfileCard(props: {
  relationship: Relationship;
  onMessage: () => void;
  onRequest: (message: string) => void;
  onAccept: () => void;
  onReject: () => void;
  onWithdraw: () => void;
  onRemark: (remark: string) => void;
  onDelete: () => void;
  onBlock: () => void;
  onUnblock: () => void;
  onReport: () => void;
}) {
  const { t } = useI18n();
  const { relationship: rel } = props;
  const [note, setNote] = useState("");
  const [remark, setRemark] = useState(rel.remark);
  return (
    <>
      <Avatar name={rel.peer.displayName} url={rel.peer.avatarUrl} large />
      <b>{rel.remark || rel.peer.displayName}</b>
      {rel.remark ? <p className="muted">{rel.peer.displayName}</p> : null}
      <div className="kk">{rel.peer.kkNumber ?? "—"}</div>
      <p className="muted">{t("kkNumber")}</p>
      <p>{rel.peer.username ? `${t("username")} @${rel.peer.username}` : t("noUsername")}</p>
      {rel.isSelf ? null : (
        <div className="stack">
          {rel.friend ? (
            <>
              <p className="ok">{t("alreadyFriends")}</p>
              <button className="btn btn-primary" type="button" onClick={props.onMessage}>{t("message")}</button>
              <label className="field">
                <span>{t("remark")}</span>
                <input value={remark} placeholder={t("remarkPlaceholder")} maxLength={40} onChange={(event) => setRemark(event.target.value)} />
              </label>
              <button className="btn btn-ghost" type="button" onClick={() => props.onRemark(remark)}>{t("setRemark")}</button>
              <button className="btn btn-ghost danger" type="button" onClick={props.onDelete}>{t("deleteFriend")}</button>
            </>
          ) : rel.incoming ? (
            <>
              <p>{t("requestIncoming")}</p>
              {rel.incoming.message ? <blockquote>{rel.incoming.message}</blockquote> : null}
              <button className="btn btn-primary" type="button" onClick={props.onAccept}>{t("accept")}</button>
              <button className="btn btn-ghost" type="button" onClick={props.onReject}>{t("reject")}</button>
            </>
          ) : rel.outgoing ? (
            <>
              <p>{t("requestSent")}</p>
              <button className="btn btn-ghost" type="button" onClick={props.onWithdraw}>{t("withdraw")}</button>
            </>
          ) : rel.blockedByMe ? null : (
            <>
              <label className="field">
                <span>{t("requestMessage")}</span>
                <input value={note} maxLength={120} onChange={(event) => setNote(event.target.value)} />
              </label>
              <button className="btn btn-primary" type="button" onClick={() => props.onRequest(note)}>{t("sendRequest")}</button>
            </>
          )}
          {!rel.friend && rel.canMessage ? <button className="btn btn-ghost" type="button" onClick={props.onMessage}>{t("message")}</button> : null}
          {rel.blockedByMe ? (
            <button className="btn btn-ghost" type="button" onClick={props.onUnblock}>{t("unblock")}</button>
          ) : (
            <button className="btn btn-ghost danger" type="button" onClick={props.onBlock}>{t("block")}</button>
          )}
          <button className="btn btn-ghost" type="button" onClick={props.onReport}>{t("report")}</button>
        </div>
      )}
    </>
  );
}

export function Avatar({ name, url, large = false }: { name: string; url: string; large?: boolean }) {
  const letter = Array.from(name || "?")[0];
  return (
    <span className={large ? "avatar-lg" : "avatar"}>
      {url ? (
        // 头像地址来自账号中心，域名不固定，不能交给构建期图片优化。
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" />
      ) : (
        letter
      )}
    </span>
  );
}
