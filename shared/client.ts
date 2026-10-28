import type {
  FriendRequestView,
  FriendView,
  InboxItem,
  InviteView,
  Me,
  PrivacyView,
  PublicMessage,
  PublicUser,
  Relationship,
  ReleaseSummary,
  ReportReason,
  SearchHit,
  SendRequestResult,
  SyncPage,
  Thread,
} from "./types";

/**
 * 网页与 App 共用的接口客户端。只用标准 fetch，不碰服务端模块。
 * 网页：Cookie 会话 + CSRF 头；App：Authorization 头里的短期聊天凭证。
 */
export type ClientAdapter = {
  baseUrl: string;
  /** 每次请求的认证头。App 在这里处理凭证刷新；网页返回 CSRF 头。 */
  headers(mutation: boolean): Promise<Record<string, string>>;
  /** 401 时调用一次（App 用来刷新凭证），返回 true 表示可以重试。 */
  onUnauthorized?(): Promise<boolean>;
  fetchImpl?: typeof fetch;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Init = { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal };

export function createClient(adapter: ClientAdapter) {
  const doFetch = adapter.fetchImpl || fetch;

  async function request<T>(path: string, init: Init = {}, retried = false): Promise<T> {
    const method = init.method || "GET";
    const mutation = method !== "GET";
    const headers: Record<string, string> = { accept: "application/json", ...(await adapter.headers(mutation)) };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    }
    let response: Response;
    try {
      response = await doFetch(`${adapter.baseUrl}${path}`, { method, headers, body, signal: init.signal, credentials: "include" });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(0, "network");
    }
    if (response.status === 401 && !retried && adapter.onUnauthorized && (await adapter.onUnauthorized())) {
      return request<T>(path, init, true);
    }
    const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
    if (!response.ok) throw new ApiError(response.status, data.error || `HTTP ${response.status}`, data.code);
    return data;
  }

  const enc = encodeURIComponent;

  return {
    request,
    me: () => request<Me>("/api/me"),
    inbox: () => request<{ conversations: InboxItem[] }>("/api/conversations").then((r) => r.conversations),
    openDirect: (peerSub: string) => request<{ conversationId: string }>("/api/conversations", { method: "POST", json: { peerSub } }),
    thread: (id: string, beforeSeq?: number) =>
      request<Thread>(`/api/conversations/${enc(id)}${beforeSeq ? `?beforeSeq=${beforeSeq}` : ""}`),
    messages: (id: string, query: { beforeSeq?: number; afterSeq?: number; limit?: number }) => {
      const params = new URLSearchParams();
      if (query.beforeSeq != null) params.set("beforeSeq", String(query.beforeSeq));
      if (query.afterSeq != null) params.set("afterSeq", String(query.afterSeq));
      if (query.limit != null) params.set("limit", String(query.limit));
      return request<{ messages: PublicMessage[]; hasMore: boolean }>(`/api/conversations/${enc(id)}/messages?${params}`);
    },
    send: (id: string, input: { body: string; clientMessageId: string; type?: "TEXT" | "IMAGE" | "FILE"; attachmentId?: string }) =>
      request<{ message: PublicMessage; duplicate: boolean }>(`/api/conversations/${enc(id)}/messages`, { method: "POST", json: input }),
    markRead: (id: string, upToSeq?: number) =>
      request<{ unreadCount: number; lastReadSeq: number }>(`/api/conversations/${enc(id)}/read`, {
        method: "POST",
        json: upToSeq != null ? { upToSeq } : {},
      }),
    presence: (id: string) => request<{ ok: boolean }>(`/api/conversations/${enc(id)}/presence`, { method: "POST", json: {} }),
    setPrefs: (id: string, prefs: { pinned?: boolean; muted?: boolean }) =>
      request<{ pinned: boolean; muted: boolean }>(`/api/conversations/${enc(id)}`, { method: "PATCH", json: prefs }),
    recall: (messageId: string) => request<{ message: PublicMessage }>(`/api/messages/${enc(messageId)}/recall`, { method: "POST", json: {} }),
    upload: (conversationId: string, form: FormData) =>
      request<{ attachment: { id: string; name: string; mimeType: string; size: number } }>(
        `/api/conversations/${enc(conversationId)}/attachments`,
        { method: "POST", form },
      ),
    attachmentUrl: (id: string) => `${adapter.baseUrl}/api/attachments/${enc(id)}`,
    search: (keyword: string) => {
      const text = keyword.trim();
      const params = new URLSearchParams();
      if (/^[1-9]\d{0,11}$/.test(text)) params.set("kkNumber", text);
      else if (/^[a-zA-Z][a-zA-Z0-9_]{3,19}$/.test(text)) params.set("username", text.toLowerCase());
      else params.set("q", text);
      return request<{ users: SearchHit[] }>(`/api/directory?${params}`).then((r) => r.users);
    },
    searchByName: (keyword: string) =>
      request<{ users: SearchHit[] }>(`/api/directory?q=${enc(keyword.trim())}`).then((r) => r.users),
    relationship: (sub: string) => request<Relationship>(`/api/users/${enc(sub)}`),
    friends: () => request<{ friends: FriendView[] }>("/api/friends").then((r) => r.friends),
    requests: () => request<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>("/api/friend-requests"),
    sendRequest: (input: { addresseeSub: string; message?: string; source?: string; clientRequestId: string }) =>
      request<SendRequestResult>("/api/friend-requests", { method: "POST", json: input }),
    respond: (requestId: string, action: "accept" | "reject" | "cancel") =>
      request<{ conversationId?: string | null; status?: string }>(`/api/friend-requests/${enc(requestId)}/${action}`, {
        method: "POST",
        json: {},
      }),
    removeFriend: (sub: string) => request<{ removed: boolean }>(`/api/friends/${enc(sub)}`, { method: "DELETE" }),
    setRemark: (sub: string, remark: string) => request<{ remark: string }>(`/api/friends/${enc(sub)}`, { method: "PATCH", json: { remark } }),
    blocks: () => request<{ blocks: Array<{ peer: PublicUser; since: string }> }>("/api/blocks").then((r) => r.blocks),
    block: (targetSub: string) => request<{ blocked: boolean }>("/api/blocks", { method: "POST", json: { targetSub } }),
    unblock: (sub: string) => request<{ unblocked: boolean }>(`/api/blocks/${enc(sub)}`, { method: "DELETE" }),
    report: (input: { targetSub: string; reason: ReportReason; detail?: string; messageId?: string; conversationId?: string }) =>
      request<{ report: { id: string; status: string } }>("/api/reports", { method: "POST", json: input }),
    privacy: () => request<PrivacyView>("/api/me/privacy"),
    setPrivacy: (patch: Partial<PrivacyView>) => request<PrivacyView>("/api/me/privacy", { method: "PUT", json: patch }),
    createInvite: () => request<InviteView>("/api/invites", { method: "POST", json: {} }),
    revokeInvites: () => request<{ revoked: number }>("/api/invites", { method: "DELETE" }),
    resolveInvite: (token: string) =>
      request<{ owner: PublicUser; expiresAt: string; relationship: Relationship }>(`/api/invites/${enc(token)}`),
    requestViaInvite: (token: string, input: { message?: string; clientRequestId: string }) =>
      request<SendRequestResult>(`/api/invites/${enc(token)}`, { method: "POST", json: input }),
    sync: (since: number, limit = 200) => request<SyncPage>(`/api/sync?since=${since}&limit=${limit}`),
    releases: () => request<ReleaseSummary>("/api/releases/latest"),
  };
}

export type KkchatClient = ReturnType<typeof createClient>;

export function newClientId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  const hex = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < 32; index += 1) out += hex[Math.floor(Math.random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-a${out.slice(17, 20)}-${out.slice(20, 32)}`;
}
