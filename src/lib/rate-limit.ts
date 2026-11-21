/**
 * 聊天与原生登录的限额。
 * 没配 Redis 时仍是单进程窗口。RATE_LIMIT_BACKEND=redis 且 REDIS_URL 有值时，
 * 多实例共用同一段原子计数。短信式的登录入口在 Redis 不可用时拒绝；普通聊天退回本进程限额。
 */

import { createHash, createHmac } from "node:crypto";

type Hit = number[];

export type LimitDecision = {
  ok: boolean;
  retryAfterSec: number;
  degraded?: boolean;
};

type RedisLike = {
  eval(script: string, numkeys: number, ...args: Array<string | number>): Promise<unknown>;
};

const WINDOW_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local count = redis.call('INCR', key)
local ttl = redis.call('PTTL', key)
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', key, windowMs)
  ttl = windowMs
end
return {count, ttl}
`;

let redisPromise: Promise<RedisLike | null> | null = null;

async function redisClient(): Promise<RedisLike | null> {
  if ((process.env.RATE_LIMIT_BACKEND || "") !== "redis" || !(process.env.REDIS_URL || "").trim()) return null;
  if (!redisPromise) {
    redisPromise = import("ioredis")
      .then((mod) => {
        const Redis = mod.default as new (url: string, opts?: Record<string, unknown>) => RedisLike & { connect?: () => Promise<void> };
        const client = new Redis(process.env.REDIS_URL || "", {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: true,
        });
        return client.connect ? client.connect().then(() => client) : client;
      })
      .catch(() => null);
  }
  return redisPromise;
}

function digest(name: string, key: string): string {
  const secret = (process.env.RATE_LIMIT_KEY_HMAC_SECRET || process.env.AUTH_SECRET || "").trim();
  const material = `${name}\0${key}`;
  const hash = secret
    ? createHmac("sha256", secret).update(material).digest("hex")
    : createHash("sha256").update(material).digest("hex");
  return `kkchat:${name}:${hash}`;
}

export function createRateLimiter(name: string, limit: number, windowMs: number, options?: { failClosed?: boolean }) {
  const hits = new Map<string, Hit>();
  function allowLocal(key: string, now = Date.now()): LimitDecision {
    const id = digest(name, key);
    const fresh = (hits.get(id) || []).filter((at) => now - at < windowMs);
    if (fresh.length >= limit) {
      hits.set(id, fresh);
      const oldest = fresh[0] || now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
    }
    fresh.push(now);
    hits.set(id, fresh);
    if (hits.size > 10_000) {
      for (const [entry, times] of hits) {
        if (times.every((at) => now - at >= windowMs)) hits.delete(entry);
      }
    }
    return { ok: true, retryAfterSec: 0 };
  }
  return {
    allow(key: string, now = Date.now()): boolean {
      return allowLocal(key, now).ok;
    },
    async allowShared(key: string, now = Date.now()): Promise<LimitDecision> {
      const client = await redisClient();
      if (!client) return allowLocal(key, now);
      try {
        const raw = await client.eval(WINDOW_SCRIPT, 1, `rl:${digest(name, key)}`, String(windowMs));
        const pair = Array.isArray(raw) ? raw : [];
        const count = Number(pair[0]);
        const ttl = Number(pair[1]);
        if (!Number.isFinite(count)) throw new Error("bad rate-limit result");
        if (count > limit) {
          return { ok: false, retryAfterSec: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)) };
        }
        return { ok: true, retryAfterSec: 0 };
      } catch {
        if (options?.failClosed) return { ok: false, retryAfterSec: 30, degraded: true };
        const local = allowLocal(key, now);
        return { ...local, degraded: true };
      }
    },
  };
}

export const sendLimiter = createRateLimiter("send", 30, 60_000);
export const searchLimiter = createRateLimiter("search", 20, 60_000);
export const serviceLimiter = createRateLimiter("service", 120, 60_000);
export const friendLimiter = createRateLimiter("friend", 30, 60_000);
export const uploadLimiter = createRateLimiter("upload", 20, 60_000);
export const nativeAuthLimiter = createRateLimiter("native-auth", 20, 60_000, { failClosed: true });
export const refreshLimiter = createRateLimiter("refresh", 30, 60_000, { failClosed: true });
export const inviteLimiter = createRateLimiter("invite", 30, 60_000);
