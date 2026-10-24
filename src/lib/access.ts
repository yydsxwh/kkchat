import { buildPairKey, ChatError } from "./domain";
import type { Tx } from "./tx";

export type DirectAccess =
  | { allowed: true; via: "friend" | "grant" }
  | { allowed: false; reason: "blocked_by_me" | "blocked" | "not_friends" };

/**
 * 个人私聊的唯一权限入口。网页、App、服务接口、实时层都走这里。
 *
 * 规则：任一方向拉黑 → 不能发；好友关系 ACTIVE → 可以；
 * 有未撤销的兼容/业务授权（DirectGrant）→ 可以；否则需要先成为好友。
 * 国家、手机号区号、语言、下载渠道都不参与判断。
 */
export async function directAccess(tx: Tx, senderSub: string, recipientSub: string): Promise<DirectAccess> {
  const pairKey = buildPairKey(senderSub, recipientSub);
  const blocks = await tx.userBlock.findMany({
    where: {
      OR: [
        { blockerSub: senderSub, blockedSub: recipientSub },
        { blockerSub: recipientSub, blockedSub: senderSub },
      ],
    },
    select: { blockerSub: true },
  });
  if (blocks.some((row) => row.blockerSub === senderSub)) return { allowed: false, reason: "blocked_by_me" };
  if (blocks.length > 0) return { allowed: false, reason: "blocked" };
  const friendship = await tx.friendship.findUnique({ where: { pairKey }, select: { status: true } });
  if (friendship?.status === "ACTIVE") return { allowed: true, via: "friend" };
  const grant = await tx.directGrant.findFirst({ where: { pairKey, revokedAt: null }, select: { id: true } });
  if (grant) return { allowed: true, via: "grant" };
  return { allowed: false, reason: "not_friends" };
}

export async function isBlockedEitherWay(tx: Tx, a: string, b: string) {
  const count = await tx.userBlock.count({
    where: {
      OR: [
        { blockerSub: a, blockedSub: b },
        { blockerSub: b, blockedSub: a },
      ],
    },
  });
  return count > 0;
}

/** 被对方拉黑与「还不是好友」给同一句提示，不向发起人泄露拉黑状态。 */
export function accessError(access: DirectAccess): ChatError {
  if (access.allowed) return new ChatError(500, "内部错误");
  if (access.reason === "blocked_by_me") return new ChatError(403, "你已拉黑对方，解除拉黑后才能发消息");
  return new ChatError(403, "你们还不是好友，请先发送好友申请");
}

export async function revokeGrants(tx: Tx, pairKey: string, reason: string, now: Date) {
  const result = await tx.directGrant.updateMany({
    where: { pairKey, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
  return result.count;
}
