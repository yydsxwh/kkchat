import type { PrismaClient } from "@prisma/client";
import { pruneStaleAttachments } from "./attachments";
import { httpSessionStatus, type SessionStatusClient } from "./native-auth";
import type { RealtimeBus } from "./realtime";
import { pruneEvents } from "./sync";

/** 撤销传播目标：账号中心撤销会话后 60 秒内，KKChat 的网页与设备会话一起失效。 */
export const SWEEP_INTERVAL_MS = 30_000;
const BATCH = 200;

/**
 * 找出仍有效、带账号中心 sid 的网页与设备会话，批量问账号中心这些 sid 是否还活着。
 * 账号中心不可达时什么也不改：设备会话的刷新另有硬上限（见 native-auth），不会因此无限延长。
 */
export async function sweepRevokedSessions(
  db: PrismaClient,
  bus: RealtimeBus,
  status: SessionStatusClient = httpSessionStatus,
  now = new Date(),
) {
  const devices = await db.deviceSession.findMany({
    where: { revokedAt: null, expiresAt: { gt: now } },
    orderBy: { sourceCheckedAt: "asc" },
    take: BATCH,
    select: { id: true, accountSub: true, accountSid: true },
  });
  const browsers = await db.browserSession.findMany({
    where: { revokedAt: null, expiresAt: { gt: now }, accountSid: { not: null } },
    take: BATCH,
    select: { id: true, accountSub: true, accountSid: true },
  });
  const sids = [...new Set([...devices.map((row) => row.accountSid), ...browsers.map((row) => row.accountSid!)])];
  if (sids.length === 0) return { checked: 0, revoked: 0 };
  const alive = await status.check(sids);
  let revoked = 0;
  for (const device of devices) {
    if (alive.get(device.accountSid) === true) continue;
    const result = await db.deviceSession.updateMany({
      where: { id: device.id, revokedAt: null },
      data: { revokedAt: now, revokeReason: "account_session_revoked" },
    });
    await db.pushDevice.updateMany({ where: { sessionId: device.id, revokedAt: null }, data: { revokedAt: now } });
    if (result.count === 1) {
      revoked += 1;
      bus.disconnect(device.accountSub, device.id);
    }
  }
  for (const browser of browsers) {
    if (alive.get(browser.accountSid!) === true) continue;
    const result = await db.browserSession.updateMany({ where: { id: browser.id, revokedAt: null }, data: { revokedAt: now } });
    if (result.count === 1) {
      revoked += 1;
      bus.disconnect(browser.accountSub, browser.id);
    }
  }
  const aliveDevices = devices.filter((row) => alive.get(row.accountSid) === true).map((row) => row.id);
  if (aliveDevices.length > 0) {
    await db.deviceSession.updateMany({ where: { id: { in: aliveDevices } }, data: { sourceCheckedAt: now } });
  }
  return { checked: sids.length, revoked };
}

let started = false;

export function startSweeper(db: PrismaClient, bus: RealtimeBus) {
  if (started) return;
  started = true;
  let running = false;
  let lastPrune = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepRevokedSessions(db, bus);
    } catch {
      // 账号中心暂时不可达：下一轮再试，不打印凭证。
    }
    try {
      if (Date.now() - lastPrune > 60 * 60 * 1000) {
        lastPrune = Date.now();
        await pruneEvents(db);
        await pruneStaleAttachments(db);
        await db.nativeLoginTransaction.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
      }
    } catch {
      // 清理失败不影响聊天。
    }
    running = false;
  };
  const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}
