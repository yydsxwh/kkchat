import type { PrismaClient } from "@prisma/client";
import { ChatError } from "./domain";
import type { RealtimeBus, RealtimeEvent, RealtimeKind } from "./realtime";
import type { Tx } from "./tx";

export const SYNC_PAGE_MAX = 500;
/** 事件保留 30 天。客户端游标比最早保留的事件还旧时，要求重新对齐全量状态。 */
export const SYNC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type PendingEvent = {
  accountSubs: string[];
  kind: RealtimeKind;
  conversationId?: string | null;
  data: Record<string, unknown>;
};

/**
 * 在调用方事务里为每个接收者分配递增序号并写入事件。
 * UserSyncState 的行锁保证同一账号的序号按提交顺序递增、不跳号；
 * 按 sub 排序加锁，避免两个事务交叉加锁死锁。
 */
export async function appendEvents(tx: Tx, events: PendingEvent[]): Promise<RealtimeEvent[]> {
  const written: RealtimeEvent[] = [];
  for (const event of events) {
    const subs = [...new Set(event.accountSubs)].sort();
    if (subs.length === 0) continue;
    const rows = await tx.$queryRaw<Array<{ accountSub: string; lastSeq: number }>>`
      INSERT INTO "UserSyncState" ("accountSub", "lastSeq", "updatedAt")
      SELECT s, 1, CURRENT_TIMESTAMP FROM unnest(${subs}::text[]) WITH ORDINALITY AS t(s, ord)
      ORDER BY ord
      ON CONFLICT ("accountSub") DO UPDATE
        SET "lastSeq" = "UserSyncState"."lastSeq" + 1, "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "accountSub", "lastSeq"`;
    const payloadJson = JSON.stringify(event.data);
    await tx.syncEvent.createMany({
      data: rows.map((row) => ({
        accountSub: row.accountSub,
        seq: row.lastSeq,
        kind: event.kind,
        conversationId: event.conversationId ?? null,
        payloadJson,
      })),
    });
    for (const row of rows) {
      written.push({
        accountSub: row.accountSub,
        seq: row.lastSeq,
        kind: event.kind,
        conversationId: event.conversationId ?? null,
        data: event.data,
      });
    }
  }
  return written;
}

export function publishCommitted(bus: RealtimeBus, events: RealtimeEvent[]) {
  if (events.length > 0) bus.publish(events);
}

export type SyncPage = {
  events: Array<{ seq: number; kind: string; conversationId: string | null; data: Record<string, unknown>; createdAt: string }>;
  nextSeq: number;
  latestSeq: number;
  hasMore: boolean;
  /** 游标早于保留窗口：客户端必须重新拉会话列表、好友、申请等全量状态，再从 latestSeq 继续。 */
  resyncRequired: boolean;
};

export async function readEvents(db: PrismaClient, accountSub: string, since: number, limit: number): Promise<SyncPage> {
  if (!Number.isInteger(since) || since < 0) throw new ChatError(400, "同步游标无效");
  const take = Math.min(Math.max(limit, 1), SYNC_PAGE_MAX);
  const state = await db.userSyncState.findUnique({ where: { accountSub } });
  const latestSeq = state?.lastSeq ?? 0;
  if (since > latestSeq) {
    return { events: [], nextSeq: latestSeq, latestSeq, hasMore: false, resyncRequired: true };
  }
  if (since < latestSeq) {
    const oldest = await db.syncEvent.findFirst({ where: { accountSub }, orderBy: { seq: "asc" }, select: { seq: true } });
    if (!oldest || oldest.seq > since + 1) {
      return { events: [], nextSeq: latestSeq, latestSeq, hasMore: false, resyncRequired: true };
    }
  }
  const rows = await db.syncEvent.findMany({
    where: { accountSub, seq: { gt: since } },
    orderBy: { seq: "asc" },
    take: take + 1,
  });
  const page = rows.slice(0, take);
  return {
    events: page.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      conversationId: row.conversationId,
      data: safeParse(row.payloadJson),
      createdAt: row.createdAt.toISOString(),
    })),
    nextSeq: page.length > 0 ? page[page.length - 1].seq : since,
    latestSeq,
    hasMore: rows.length > take,
    resyncRequired: false,
  };
}

export async function latestSeq(db: PrismaClient, accountSub: string): Promise<number> {
  const state = await db.userSyncState.findUnique({ where: { accountSub } });
  return state?.lastSeq ?? 0;
}

export async function pruneEvents(db: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - SYNC_RETENTION_MS);
  const result = await db.syncEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // 坏数据按空对象处理。
  }
  return {};
}
