import EventSource from "react-native-sse";
import { API_BASE_URL } from "./config";

export type RealtimePayload = { seq: number; conversationId: string | null; data: Record<string, unknown> };
type Kind = "ready" | "message" | "recall" | "read" | "conversation" | "friend" | "request" | "block" | "session";

const KINDS: Kind[] = ["ready", "message", "recall", "read", "conversation", "friend", "request", "block", "session"];

/**
 * 前台实时连接。凭证放在 Authorization 头里，不进 URL。
 * 断线指数退避重连（1s → 30s）；每次连上（ready）都让上层按 seq 补拉，丢的、乱序的事件都能补齐。
 * 后台不承诺常驻连接：App 回到前台时重新连接并补拉。
 */
export class RealtimeConnection {
  private source: EventSource<Kind> | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly handlers: {
      onEvent(kind: Exclude<Kind, "ready" | "session">, payload: RealtimePayload): void;
      onReady(latestSeq: number): void;
      onState(state: "online" | "connecting" | "offline"): void;
      onRevoked(): void;
    },
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.open();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.close();
  }

  /** 网络恢复或回到前台时立即重连，不等退避计时。 */
  kick() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.close();
    void this.open();
  }

  private close() {
    if (!this.source) return;
    this.source.removeAllEventListeners();
    this.source.close();
    this.source = null;
  }

  private async open() {
    if (this.stopped) return;
    this.handlers.onState("connecting");
    let token: string;
    try {
      token = await this.getToken();
    } catch {
      this.handlers.onState("offline");
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    const source = new EventSource<Kind>(`${API_BASE_URL}/api/realtime`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      pollingInterval: 0,
      timeoutBeforeConnection: 0,
    });
    this.source = source;
    for (const kind of KINDS) {
      source.addEventListener(kind, (event) => {
        const raw = (event as { data?: string | null }).data;
        if (kind === "ready") {
          this.attempt = 0;
          this.handlers.onState("online");
          const latest = raw ? Number((JSON.parse(raw) as { latestSeq?: number }).latestSeq || 0) : 0;
          this.handlers.onReady(latest);
          return;
        }
        if (kind === "session") {
          this.stop();
          this.handlers.onRevoked();
          return;
        }
        if (!raw) return;
        try {
          this.handlers.onEvent(kind, JSON.parse(raw) as RealtimePayload);
        } catch {
          // 坏数据丢弃，靠补拉兜底。
        }
      });
    }
    source.addEventListener("error", () => {
      if (this.source !== source) return;
      this.close();
      this.handlers.onState("offline");
      this.scheduleRetry();
    });
    source.addEventListener("close", () => {
      if (this.source !== source) return;
      this.close();
      this.scheduleRetry();
    });
  }

  private scheduleRetry() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, delay);
  }
}
