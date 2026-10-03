/** 单进程滑窗。多实例时换成 Redis，调用方只依赖 allow()。 */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, now = Date.now()): boolean {
      const fresh = (hits.get(key) || []).filter((at) => now - at < windowMs);
      if (fresh.length >= limit) {
        hits.set(key, fresh);
        return false;
      }
      fresh.push(now);
      hits.set(key, fresh);
      return true;
    },
  };
}

export const sendLimiter = createRateLimiter(30, 60_000);
export const searchLimiter = createRateLimiter(20, 60_000);
export const serviceLimiter = createRateLimiter(120, 60_000);
