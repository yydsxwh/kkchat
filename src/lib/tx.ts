import type { Prisma, PrismaClient } from "@prisma/client";

export type Tx = Prisma.TransactionClient;

const RETRYABLE = new Set(["P2034", "40001", "40P01"]);

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (code && RETRYABLE.has(code)) return true;
  const meta = (error as { meta?: { code?: string } }).meta;
  if (meta?.code && RETRYABLE.has(meta.code)) return true;
  const message = String((error as { message?: string }).message || "");
  return /deadlock detected|could not serialize access/i.test(message);
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (code === "P2002" || code === "23505") return true;
  const meta = (error as { meta?: { code?: string } }).meta;
  return meta?.code === "23505";
}

/**
 * 交互式事务。死锁或序列化失败时整段重跑，业务函数必须只依赖事务内读到的数据。
 * 不在事务里做跨服务网络请求，避免长时间持锁。
 */
export async function withTx<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await db.$transaction(fn, { maxWait: 10_000, timeout: 15_000 });
    } catch (error) {
      last = error;
      if (!retryable(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw last;
}

/** 同一对账号的好友、拉黑、申请操作串行执行。键只由两个 sub 决定。 */
export async function lockPair(tx: Tx, pairKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pair:${pairKey}`}, 0))`;
}
