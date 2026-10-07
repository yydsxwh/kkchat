"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CurrentUser } from "@/lib/current-user";

type Peer = {
  accountSub: string;
  kkNumber: number | null;
  username: string | null;
  displayName: string;
  avatarUrl: string;
};

type Conversation = {
  id: string;
  kind: "DIRECT" | "GROUP" | "CHANNEL";
  title: string;
  avatarUrl: string;
  peer: Peer | null;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unreadCount: number;
};

type ChatMessage = {
  id: string;
  conversationId: string;
  senderSub: string;
  type: string;
  body: string | null;
  recalledAt: string | null;
  createdAt: string;
  read: boolean;
  localStatus?: "sending" | "failed";
};

type DirectoryHit = {
  sub: string;
  kk_number: number | null;
  username: string | null;
  name: string;
  avatar: string;
};

export function ChatShell({ me, initialConversationId }: { me: CurrentUser; initialConversationId: string }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DirectoryHit[]>([]);
  const [searchError, setSearchError] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMembers, setGroupMembers] = useState<DirectoryHit[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [stick, setStick] = useState(true);
  const [now, setNow] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const active = conversations.find((item) => item.id === activeId) || null;

  const loadInbox = useCallback(async () => {
    const data = await api<{ conversations: Conversation[] }>("/api/conversations");
    setConversations(data.conversations);
  }, []);

  const loadThread = useCallback(async (id: string) => {
    const data = await api<{ messages: ChatMessage[] }>(`/api/conversations/${id}`);
    setMessages(data.messages);
    await api(`/api/conversations/${id}/read`, { method: "POST", json: {} });
    setConversations((prev) => prev.map((item) => (item.id === id ? { ...item, unreadCount: 0 } : item)));
  }, []);

  useEffect(() => {
    const update = () => setNow(Date.now());
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // 列表在服务端，挂载后拉取；不能在渲染期间发请求。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInbox().catch(() => undefined);
  }, [loadInbox]);

  useEffect(() => {
    if (!activeId) return;
    // 切换会话时向服务端取消息，失败则回到列表。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadThread(activeId).catch(() => setActiveId(""));
  }, [activeId, loadThread]);

  useEffect(() => {
    if (!activeId) return;
    const ping = () => {
      void api(`/api/conversations/${activeId}/presence`, { method: "POST", json: {} }).catch(() => undefined);
    };
    ping();
    const timer = setInterval(ping, 20_000);
    return () => clearInterval(timer);
  }, [activeId]);

  useEffect(() => {
    const source = new EventSource("/api/realtime");
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data) as ChatMessage;
      setConversations((prev) => bumpConversation(prev, message, activeId, me.accountSub));
      if (message.senderSub === me.accountSub) return;
      if (message.conversationId !== activeId) return;
      setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message]));
      if (stickRef.current) {
        void api(`/api/conversations/${message.conversationId}/read`, { method: "POST", json: {} });
      } else {
        setUnseen((count) => count + 1);
      }
    };
    const onRecall = (event: MessageEvent) => {
      const message = JSON.parse(event.data) as ChatMessage;
      setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, ...message } : item)));
    };
    const onRead = () => {
      if (!activeId) return;
      void loadThread(activeId);
    };
    source.addEventListener("message", onMessage);
    source.addEventListener("recall", onRecall);
    source.addEventListener("read", onRead);
    return () => source.close();
  }, [activeId, loadThread, me.accountSub]);

  useEffect(() => {
    if (!stick) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, stick, activeId]);

  const unreadTotal = useMemo(
    () => conversations.reduce((sum, item) => sum + item.unreadCount, 0),
    [conversations],
  );

  async function search(text: string) {
    const keyword = text.trim();
    setQuery(text);
    setSearchError("");
    if (!keyword) {
      setHits([]);
      return;
    }
    const params = new URLSearchParams();
    if (/^[1-9]\d{1,11}$/.test(keyword)) params.set("kkNumber", keyword);
    else if (/^[a-zA-Z][a-zA-Z0-9_]{3,19}$/.test(keyword)) params.set("username", keyword.toLowerCase());
    else params.set("q", keyword);
    try {
      const data = await api<{ users: DirectoryHit[] }>(`/api/directory?${params.toString()}`);
      let users = data.users;
      if (users.length === 0 && params.has("username")) {
        const again = await api<{ users: DirectoryHit[] }>(`/api/directory?q=${encodeURIComponent(keyword)}`);
        users = again.users;
      }
      setHits(users);
    } catch (error) {
      setHits([]);
      setSearchError(error instanceof Error ? error.message : "搜索失败");
    }
  }

  async function openDirect(hit: DirectoryHit) {
    const data = await api<{ conversationId: string }>("/api/conversations", {
      method: "POST",
      json: {
        recipientSub: hit.sub,
        displayName: hit.name,
        kkNumber: hit.kk_number,
        username: hit.username,
        avatarUrl: hit.avatar,
      },
    });
    setHits([]);
    setQuery("");
    setActiveId(data.conversationId);
    setShowProfile(false);
    window.history.replaceState(null, "", `/app/conversations/${data.conversationId}`);
    await loadInbox();
  }

  async function send() {
    const text = draft.trim();
    if (!text || !activeId) return;
    const idempotencyKey = crypto.randomUUID();
    const localId = `local-${idempotencyKey}`;
    const optimistic: ChatMessage = {
      id: localId,
      conversationId: activeId,
      senderSub: me.accountSub,
      type: "TEXT",
      body: text,
      recalledAt: null,
      createdAt: new Date().toISOString(),
      read: false,
      localStatus: "sending",
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");
    setStick(true);
    stickRef.current = true;
    try {
      const data = await api<{ message: ChatMessage }>(`/api/conversations/${activeId}/messages`, {
        method: "POST",
        json: { body: text, idempotencyKey },
      });
      setMessages((prev) => prev.map((item) => (item.id === localId ? data.message : item)));
      void loadInbox();
    } catch {
      setMessages((prev) => prev.map((item) => (item.id === localId ? { ...item, localStatus: "failed" } : item)));
    }
  }

  async function recall(id: string) {
    const data = await api<{ message: ChatMessage }>(`/api/messages/${id}/recall`, { method: "POST", json: {} });
    setMessages((prev) => prev.map((item) => (item.id === id ? data.message : item)));
  }

  async function createGroup() {
    const data = await api<{ conversationId: string }>("/api/groups", {
      method: "POST",
      json: { title: groupTitle, memberSubs: groupMembers.map((item) => item.sub) },
    });
    setShowGroup(false);
    setGroupTitle("");
    setGroupMembers([]);
    setActiveId(data.conversationId);
    await loadInbox();
  }

  return (
    <div className={`shell${activeId ? " thread-open" : ""}${showProfile ? " show-profile" : ""}`}>
      <aside className="pane list-pane">
        <div className="pane-head">
          <Link href="/" className="wordmark">
            <span className="mark">KK</span>
            <strong>KKChat</strong>
          </Link>
          {unreadTotal > 0 ? <span className="badge">{unreadTotal > 99 ? "99+" : unreadTotal}</span> : null}
        </div>
        <form
          className="search"
          onSubmit={(event) => {
            event.preventDefault();
            void search(query);
          }}
        >
          <input
            value={query}
            placeholder="KK 号、账号或姓名"
            aria-label="查找用户"
            onChange={(event) => void search(event.target.value)}
          />
        </form>
        {searchError ? <p className="muted" style={{ padding: "0 16px" }}>{searchError}</p> : null}
        {hits.length > 0 ? (
          <div className="results">
            {hits.map((hit) => (
              <button key={hit.sub} type="button" onClick={() => void openDirect(hit)}>
                <b>{hit.name}</b>
                <small className="muted"> {hit.kk_number ? `KK ${hit.kk_number}` : hit.username || ""}</small>
              </button>
            ))}
          </div>
        ) : null}
        <div className="list">
          {conversations.length === 0 ? <p className="empty">还没有会话。用 KK 号找人，发出第一句。</p> : null}
          {conversations.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`conv${item.id === activeId ? " active" : ""}`}
              onClick={() => {
                setActiveId(item.id);
                setShowProfile(false);
                window.history.replaceState(null, "", `/app/conversations/${item.id}`);
              }}
            >
              <Avatar name={item.title} url={item.avatarUrl || item.peer?.avatarUrl || ""} />
              <span>
                <b>{item.title}</b>
                <small>{item.lastMessagePreview || "还没有消息"}</small>
              </span>
              <span>
                <small>{formatTime(item.lastMessageAt)}</small>
                {item.unreadCount > 0 ? <span className="badge">{item.unreadCount}</span> : null}
              </span>
            </button>
          ))}
        </div>
        <div className="pane-head">
          <button className="text-btn" type="button" onClick={() => setShowGroup(true)}>新建群</button>
          <Link className="text-btn" href="/app/settings">我的</Link>
        </div>
      </aside>
      <section className="pane thread">
        {active ? (
          <>
            <div className="pane-head">
              <button className="text-btn back-link" type="button" onClick={() => setActiveId("")}>返回</button>
              <div>
                <b>{active.title}</b>
                <div className="muted">{active.peer?.kkNumber ? `KK ${active.peer.kkNumber}` : active.kind === "GROUP" ? "群聊" : ""}</div>
              </div>
              <button className="text-btn" type="button" onClick={() => setShowProfile(true)}>资料</button>
            </div>
            <div
              className="messages"
              ref={scroller}
              onScroll={(event) => {
                const node = event.currentTarget;
                const near = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
                stickRef.current = near;
                setStick(near);
                if (near) setUnseen(0);
              }}
            >
              {messages.map((message) => {
                const mine = message.senderSub === me.accountSub;
                const fresh = !message.recalledAt && now - Date.parse(message.createdAt) < 2 * 60 * 1000;
                return (
                  <article key={message.id} className={`msg${mine ? " mine" : " theirs"}`}>
                    <Avatar name={mine ? me.displayName : active.title} url={mine ? me.avatarUrl : active.avatarUrl} />
                    <div className="bubble-wrap">
                      <div className="bubble">{message.recalledAt ? "已撤回一条消息" : message.body}</div>
                      <div className="meta">
                        <span>{formatTime(message.createdAt)}</span>
                        {message.localStatus === "sending" ? <span>发送中</span> : null}
                        {message.localStatus === "failed" ? <span>失败</span> : null}
                        {mine && !message.localStatus && !message.recalledAt ? <span>{message.read ? "已读" : "未读"}</span> : null}
                        {mine && fresh && !message.recalledAt && !message.id.startsWith("local-") ? (
                          <button className="text-btn" type="button" onClick={() => void recall(message.id)}>撤回</button>
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
                    setStick(true);
                    setUnseen(0);
                  }}
                >
                  {unseen} 条新消息
                </button>
              ) : null}
            </div>
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <textarea
                value={draft}
                aria-label="输入消息"
                placeholder="写一条消息"
                rows={1}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  if (window.matchMedia("(max-width: 800px)").matches) return;
                  event.preventDefault();
                  void send();
                }}
              />
              <button className="btn btn-primary" type="submit">发送</button>
            </form>
          </>
        ) : (
          <div className="empty">
            <p>选一个会话，或用 KK 号开始私聊。</p>
          </div>
        )}
      </section>
      <aside className="pane profile-pane">
        <div className="profile-head">
          <button className="text-btn back-link" type="button" onClick={() => setShowProfile(false)}>返回</button>
          <b>会话资料</b>
        </div>
        <div className="profile">
          {active?.peer ? (
            <>
              <Avatar name={active.peer.displayName} url={active.peer.avatarUrl} large />
              <b>{active.peer.displayName}</b>
              <div className="kk">{active.peer.kkNumber ? active.peer.kkNumber : "—"}</div>
              <p className="muted">KK 号</p>
              <p>{active.peer.username ? `账号 ${active.peer.username}` : "还没有自设账号"}</p>
            </>
          ) : active ? (
            <>
              <b>{active.title}</b>
              <p className="muted">群聊骨架已经能收发文本。复杂的群管理以后再加。</p>
            </>
          ) : (
            <p className="muted">打开会话后，这里显示对方的 KK 号。</p>
          )}
          <p><Link href="/app/settings">我的 KK 号与账号标识</Link></p>
        </div>
      </aside>
      {showGroup ? (
        <div className="modal">
          <form
            className="modal-card"
            onSubmit={(event) => {
              event.preventDefault();
              void createGroup();
            }}
          >
            <h2>新建群</h2>
            <input value={groupTitle} placeholder="群名称" aria-label="群名称" onChange={(event) => setGroupTitle(event.target.value)} />
            <p className="muted">先在左侧搜到人，再点下面把他们加进这个群。</p>
            <div>
              {hits.map((hit) => (
                <button
                  className="member-row"
                  type="button"
                  key={hit.sub}
                  onClick={() => setGroupMembers((prev) => (prev.some((item) => item.sub === hit.sub) ? prev : [...prev, hit]))}
                >
                  加入 {hit.name}
                </button>
              ))}
            </div>
            <p>{groupMembers.map((item) => item.name).join("、") || "还没有成员"}</p>
            <div className="actions">
              <button className="btn btn-primary" type="submit">创建</button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowGroup(false)}>取消</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function Avatar({ name, url, large = false }: { name: string; url: string; large?: boolean }) {
  const letter = (name || "?").slice(0, 1);
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

function formatTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function bumpConversation(prev: Conversation[], message: ChatMessage, activeId: string, meSub: string): Conversation[] {
  const preview = message.recalledAt ? "已撤回" : (message.body || "").replace(/\s+/g, " ").slice(0, 80);
  const existing = prev.find((item) => item.id === message.conversationId);
  const next = existing
    ? prev.map((item) =>
        item.id === message.conversationId
          ? {
              ...item,
              lastMessagePreview: preview,
              lastMessageAt: message.createdAt,
              unreadCount:
                item.id === activeId || message.senderSub === meSub ? item.unreadCount : item.unreadCount + 1,
            }
          : item,
      )
    : prev;
  return [...next].sort((a, b) => Date.parse(b.lastMessageAt || "") - Date.parse(a.lastMessageAt || ""));
}

async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers["content-type"] = "application/json";
  if (init.method && init.method !== "GET") headers["x-kkchat-csrf"] = readCsrf();
  const response = await fetch(path, {
    method: init.method || "GET",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function readCsrf() {
  const match = document.cookie.match(/(?:^|; )kkchat_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}
