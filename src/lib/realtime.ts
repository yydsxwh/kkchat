/**
 * 实时层只负责把已提交的同步事件推给在线连接。
 * 数据库里的 SyncEvent 才是事实源；这里丢了、进程重启了，客户端按 seq 补拉即可。
 */

export type RealtimeKind =
  | "message"
  | "recall"
  | "read"
  | "conversation"
  | "friend"
  | "request"
  | "block"
  | "session";

export type RealtimeEvent = {
  accountSub: string;
  seq: number;
  kind: RealtimeKind;
  conversationId: string | null;
  data: Record<string, unknown>;
};

export interface RealtimeBus {
  publish(events: RealtimeEvent[]): void;
  subscribe(accountSub: string, listener: (event: RealtimeEvent) => void): () => void;
  /** 让某个账号的连接立即断开，例如设备会话被撤销。 */
  disconnect(accountSub: string, sessionId: string): void;
  onDisconnect(accountSub: string, listener: (sessionId: string) => void): () => void;
}

type Listener = (event: RealtimeEvent) => void;
type DisconnectListener = (sessionId: string) => void;

export class MemoryRealtimeBus implements RealtimeBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly disconnects = new Map<string, Set<DisconnectListener>>();

  publish(events: RealtimeEvent[]): void {
    for (const event of events) {
      for (const listener of this.listeners.get(event.accountSub) || []) {
        try {
          listener(event);
        } catch {
          // 单个连接写失败不影响其他连接。
        }
      }
    }
  }

  subscribe(accountSub: string, listener: Listener): () => void {
    return add(this.listeners, accountSub, listener);
  }

  disconnect(accountSub: string, sessionId: string): void {
    for (const listener of this.disconnects.get(accountSub) || []) listener(sessionId);
  }

  onDisconnect(accountSub: string, listener: DisconnectListener): () => void {
    return add(this.disconnects, accountSub, listener);
  }
}

function add<T>(map: Map<string, Set<T>>, key: string, value: T): () => void {
  const set = map.get(key) || new Set<T>();
  set.add(value);
  map.set(key, set);
  return () => {
    set.delete(value);
    if (set.size === 0) map.delete(key);
  };
}

/**
 * 单实例部署只用进程内总线。多实例时需要共享广播（例如 Redis），
 * 但仍以 SyncEvent 补拉兜底；在没有实际多实例部署前不启用，避免本机发布 + 回环重复推送。
 */
const globalBus = globalThis as unknown as { kkchatRealtimeBus?: MemoryRealtimeBus };

export function getRealtimeBus(): RealtimeBus {
  if (!globalBus.kkchatRealtimeBus) globalBus.kkchatRealtimeBus = new MemoryRealtimeBus();
  return globalBus.kkchatRealtimeBus;
}
