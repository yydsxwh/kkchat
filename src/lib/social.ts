import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { loadConfig } from "./config";
import { randomToken, sha256Hex } from "./crypto";
import { getAccountDirectory } from "./directory";
import {
  assertUserPublicId,
  ChatError,
  cleanShortText,
  parseDirectoryQuery,
  REPORT_DETAIL_MAX,
  REPORT_REASONS,
  type ReportReason,
} from "./domain";
import { directoryToPublicUser, ensureProjection, toPublicUser, type PublicUser } from "./projection";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type PrivacyView = {
  discoverByKkNumber: boolean;
  discoverByUsername: boolean;
  discoverByName: boolean;
  allowFriendRequests: boolean;
  hideNotificationContent: boolean;
};

const DEFAULT_PRIVACY: PrivacyView = {
  discoverByKkNumber: true,
  discoverByUsername: true,
  discoverByName: true,
  allowFriendRequests: true,
  hideNotificationContent: false,
};

export async function getPrivacy(db: PrismaClient, accountSub: string): Promise<PrivacyView> {
  const row = await db.privacySetting.findUnique({ where: { accountSub: assertUserPublicId(accountSub) } });
  if (!row) return { ...DEFAULT_PRIVACY };
  return {
    discoverByKkNumber: row.discoverByKkNumber,
    discoverByUsername: row.discoverByUsername,
    discoverByName: row.discoverByName,
    allowFriendRequests: row.allowFriendRequests,
    hideNotificationContent: row.hideNotificationContent,
  };
}

export async function updatePrivacy(db: PrismaClient, accountSub: string, patch: Partial<PrivacyView>): Promise<PrivacyView> {
  const sub = assertUserPublicId(accountSub);
  const data: Partial<PrivacyView> = {};
  for (const key of Object.keys(DEFAULT_PRIVACY) as Array<keyof PrivacyView>) {
    if (typeof patch[key] === "boolean") data[key] = patch[key];
  }
  await db.privacySetting.upsert({
    where: { accountSub: sub },
    create: { accountSub: sub, ...DEFAULT_PRIVACY, ...data },
    update: data,
  });
  return getPrivacy(db, sub);
}

export type SearchHit = PublicUser & { relation: "self" | "friend" | "outgoing" | "incoming" | "none" | "blocked_by_me" };

/**
 * 用户查找：KK 号、唯一账号精确匹配，昵称辅助搜索。
 * 结果遵守对方的可发现性设置；拉黑了查找人的用户不会出现在结果里。
 * 同名结果都带 KK 号或账号，便于核对。
 */
export async function searchUsers(
  db: PrismaClient,
  viewerSub: string,
  input: { kkNumber?: string | null; username?: string | null; q?: string | null },
): Promise<SearchHit[]> {
  const viewer = assertUserPublicId(viewerSub);
  const query = parseDirectoryQuery(input);
  const found = await getAccountDirectory().search(input);
  const subs = found.map((user) => user.sub).filter((sub) => sub !== viewer);
  if (subs.length === 0) return [];
  const [privacy, blocks, friendships, pending] = await Promise.all([
    db.privacySetting.findMany({ where: { accountSub: { in: subs } } }),
    db.userBlock.findMany({
      where: { OR: [{ blockerSub: viewer, blockedSub: { in: subs } }, { blockedSub: viewer, blockerSub: { in: subs } }] },
    }),
    db.friendship.findMany({ where: { status: "ACTIVE", OR: [{ subA: viewer }, { subB: viewer }] }, select: { subA: true, subB: true } }),
    db.friendRequest.findMany({
      where: { status: "PENDING", OR: [{ requesterSub: viewer }, { addresseeSub: viewer }] },
      select: { requesterSub: true, addresseeSub: true },
    }),
  ]);
  const privacyMap = new Map(privacy.map((row) => [row.accountSub, row]));
  const blockedMe = new Set(blocks.filter((row) => row.blockedSub === viewer).map((row) => row.blockerSub));
  const blockedByMe = new Set(blocks.filter((row) => row.blockerSub === viewer).map((row) => row.blockedSub));
  const friends = new Set(friendships.map((row) => (row.subA === viewer ? row.subB : row.subA)));
  const outgoing = new Set(pending.filter((row) => row.requesterSub === viewer).map((row) => row.addresseeSub));
  const incoming = new Set(pending.filter((row) => row.addresseeSub === viewer).map((row) => row.requesterSub));
  const hits: SearchHit[] = [];
  for (const user of found) {
    if (user.sub === viewer || blockedMe.has(user.sub)) continue;
    const setting = privacyMap.get(user.sub);
    if (setting && !friends.has(user.sub)) {
      if (query.kind === "kk" && !setting.discoverByKkNumber) continue;
      if (query.kind === "username" && !setting.discoverByUsername) continue;
      if (query.kind === "name" && !setting.discoverByName) continue;
    }
    const relation: SearchHit["relation"] = blockedByMe.has(user.sub)
      ? "blocked_by_me"
      : friends.has(user.sub)
        ? "friend"
        : outgoing.has(user.sub)
          ? "outgoing"
          : incoming.has(user.sub)
            ? "incoming"
            : "none";
    hits.push({ ...directoryToPublicUser(user), relation });
  }
  return hits;
}

export function inviteUrl(token: string) {
  return `${loadConfig().origin}/i/${encodeURIComponent(token)}`;
}

/** 生成个人二维码/邀请链接。旧链接继续有效到过期，除非主动撤销。 */
export async function createInvite(db: PrismaClient, ownerSub: string, now = new Date()) {
  const sub = assertUserPublicId(ownerSub);
  const recent = await db.inviteLink.count({ where: { ownerSub: sub, createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } } });
  if (recent >= 20) throw new ChatError(429, "生成邀请太频繁，请稍后再试");
  const token = randomToken(18);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await db.inviteLink.create({ data: { id: randomUUID(), tokenHash: sha256Hex(token), ownerSub: sub, expiresAt, createdAt: now } });
  return { token, url: inviteUrl(token), expiresAt: expiresAt.toISOString() };
}

export async function revokeInvites(db: PrismaClient, ownerSub: string, now = new Date()) {
  const result = await db.inviteLink.updateMany({
    where: { ownerSub: assertUserPublicId(ownerSub), revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count;
}

/** 解析邀请：只返回邀请人的公开资料。不授予任何聊天记录读取权限，也不自动同意好友。 */
export async function resolveInvite(db: PrismaClient, token: string, now = new Date()): Promise<{ owner: PublicUser; expiresAt: string }> {
  if (!INVITE_TOKEN_RE.test(token)) throw new ChatError(404, "邀请无效或已过期");
  const invite = await db.inviteLink.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!invite || invite.revokedAt || invite.expiresAt.getTime() <= now.getTime()) throw new ChatError(404, "邀请无效或已过期");
  const owner = await ensureProjection(db, invite.ownerSub, { requireAccount: false, now });
  return { owner: toPublicUser(owner, invite.ownerSub), expiresAt: invite.expiresAt.toISOString() };
}

export async function resolveInviteOwnerSub(db: PrismaClient, token: string, now = new Date()) {
  if (!INVITE_TOKEN_RE.test(token)) throw new ChatError(404, "邀请无效或已过期");
  const invite = await db.inviteLink.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!invite || invite.revokedAt || invite.expiresAt.getTime() <= now.getTime()) throw new ChatError(404, "邀请无效或已过期");
  return invite.ownerSub;
}

/**
 * 举报。消息举报必须是该会话成员，正文留快照（撤回后审核人仍能看）。
 * 举报人只能看到自己的提交结果，其他人读不到。
 */
export async function createReport(
  db: PrismaClient,
  input: { reporterSub: string; targetSub: string; reason: string; detail?: string; messageId?: string | null; conversationId?: string | null },
  now = new Date(),
) {
  const reporter = assertUserPublicId(input.reporterSub);
  const target = assertUserPublicId(input.targetSub);
  if (reporter === target) throw new ChatError(400, "不能举报自己");
  if (!REPORT_REASONS.includes(input.reason as ReportReason)) throw new ChatError(400, "请选择举报原因");
  const recent = await db.userReport.count({ where: { reporterSub: reporter, createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } } });
  if (recent >= 20) throw new ChatError(429, "举报太频繁，请稍后再试");
  let conversationId: string | null = input.conversationId?.trim() || null;
  let messageSnapshot = "";
  if (input.messageId) {
    const message = await db.message.findUnique({ where: { id: input.messageId } });
    if (!message) throw new ChatError(404, "消息不存在");
    const member = await db.conversationMember.findUnique({
      where: { conversationId_accountSub: { conversationId: message.conversationId, accountSub: reporter } },
    });
    if (!member) throw new ChatError(403, "只能举报自己所在会话里的消息");
    if (message.senderSub !== target) throw new ChatError(400, "被举报人与消息发送者不一致");
    conversationId = message.conversationId;
    messageSnapshot = `${message.type}: ${message.body}`.slice(0, 4000);
  } else if (conversationId) {
    const member = await db.conversationMember.findUnique({
      where: { conversationId_accountSub: { conversationId, accountSub: reporter } },
    });
    if (!member) throw new ChatError(403, "只能举报自己所在会话");
  }
  await ensureProjection(db, target, { requireAccount: false, now });
  const report = await db.userReport.create({
    data: {
      id: randomUUID(),
      reporterSub: reporter,
      targetSub: target,
      conversationId,
      messageId: input.messageId || null,
      reason: input.reason,
      detail: cleanShortText(input.detail, REPORT_DETAIL_MAX),
      messageSnapshot,
      createdAt: now,
    },
  });
  return { id: report.id, status: report.status, createdAt: report.createdAt.toISOString() };
}

export async function listMyReports(db: PrismaClient, reporterSub: string) {
  const rows = await db.userReport.findMany({
    where: { reporterSub: assertUserPublicId(reporterSub) },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, targetSub: true, reason: true, status: true, resolution: true, createdAt: true, handledAt: true },
  });
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), handledAt: row.handledAt?.toISOString() ?? null }));
}

/** 审核人：环境变量白名单，或账号中心登录时带来的 ADMIN 角色。 */
export async function isModerator(db: PrismaClient, accountSub: string): Promise<boolean> {
  const list = (process.env.KKCHAT_MODERATOR_SUBS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.includes(accountSub)) return true;
  const user = await db.userProjection.findUnique({ where: { accountSub }, select: { publicRole: true, profileSource: true } });
  return user?.profileSource === "ACCOUNT" && user.publicRole === "ADMIN";
}

export async function listReportsForModerator(db: PrismaClient, moderatorSub: string, status = "OPEN") {
  if (!(await isModerator(db, moderatorSub))) throw new ChatError(403, "没有审核权限");
  const rows = await db.userReport.findMany({ where: { status }, orderBy: { createdAt: "desc" }, take: 100 });
  const subs = [...new Set(rows.flatMap((row) => [row.reporterSub, row.targetSub]))];
  const users = await db.userProjection.findMany({ where: { accountSub: { in: subs } } });
  const map = new Map(users.map((user) => [user.accountSub, user]));
  return rows.map((row) => ({
    id: row.id,
    reporter: toPublicUser(map.get(row.reporterSub) ?? null, row.reporterSub),
    target: toPublicUser(map.get(row.targetSub) ?? null, row.targetSub),
    reason: row.reason,
    detail: row.detail,
    messageSnapshot: row.messageSnapshot,
    conversationId: row.conversationId,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function resolveReport(
  db: PrismaClient,
  moderatorSub: string,
  reportId: string,
  input: { status: "RESOLVED" | "DISMISSED"; resolution?: string },
  now = new Date(),
) {
  if (!(await isModerator(db, moderatorSub))) throw new ChatError(403, "没有审核权限");
  if (input.status !== "RESOLVED" && input.status !== "DISMISSED") throw new ChatError(400, "处理结果无效");
  const updated = await db.userReport.updateMany({
    where: { id: reportId, status: "OPEN" },
    data: { status: input.status, resolution: cleanShortText(input.resolution, 500), handledBySub: moderatorSub, handledAt: now },
  });
  if (updated.count !== 1) throw new ChatError(409, "举报不存在或已处理");
  return { id: reportId, status: input.status };
}
