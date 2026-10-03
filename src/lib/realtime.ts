/**
 * 实时层只负责把已落库的事件推给在线连接。
 * 数据库才是事实源；这里丢了，刷新仍能从会话接口读到。
 */

export type RealtimeKind = "message" | "read" | "recall";

export type RealtimeEvent = {
  kind: RealtimeKind;
  conversationId: string;
  /** 只推给这些成员。调用方必须已经做过成员校验。 */
  accountSubs: string[];
  data: Record<string, unknown>;
};

export interface RealtimeBus {
  publish(event: RealtimeEvent): void;
  subscribe(accountSub: string, listener: (event: RealtimeEvent) => void): () => void;
}

type Listener = (event: RealtimeEvent) => void;

export class MemoryRealtimeBus implements RealtimeBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(event: RealtimeEvent): void {
    for (const sub of new Set(event.accountSubs)) {
      for (const listener of this.listeners.get(sub) || []) {
        listener(event);
      }
    }
  }

  subscribe(accountSub: string, listener: Listener): () => void {
    const set = this.listeners.get(accountSub) || new Set<Listener>();
    set.add(listener);
    this.listeners.set(accountSub, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(accountSub);
    };
  }
}

/**
 * Redis adapter 的形状。当前进程仍用 MemoryRealtimeBus 做本机扇出；
 * 接入时由 publish 写频道、由订阅把远端事件交回本机 bus。
 * V1 不强制连接 Redis，避免单机部署依赖一个还没配的地址。
 */
export type RedisPubSub = {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => void>;
};

export const REALTIME_CHANNEL = "kkchat:events";

export class RedisRealtimeBus implements RealtimeBus {
  private readonly local = new MemoryRealtimeBus();
  private started = false;

  constructor(private readonly redis: RedisPubSub) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.redis.subscribe(REALTIME_CHANNEL, (raw) => {
      try {
        const event = JSON.parse(raw) as RealtimeEvent;
        if (!event || !Array.isArray(event.accountSubs)) return;
        this.local.publish(event);
      } catch {
        // 坏消息丢掉，不把解析失败打进业务日志全文。
      }
    });
  }

  publish(event: RealtimeEvent): void {
    this.local.publish(event);
    void this.redis.publish(REALTIME_CHANNEL, JSON.stringify(event)).catch(() => {
      // 发布失败不影响已写入数据库的消息。
    });
  }

  subscribe(accountSub: string, listener: (event: RealtimeEvent) => void): () => void {
    return this.local.subscribe(accountSub, listener);
  }
}

const memoryBus = new MemoryRealtimeBus();

export function getRealtimeBus(): RealtimeBus {
  return memoryBus;
}
