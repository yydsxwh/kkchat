import { randomUUID } from "node:crypto";
import type { FriendRequest, PrismaClient } from "@prisma/client";
import { revokeGrants } from "./access";
import type { ChatService } from "./chat-service";
import {
  assertUserPublicId,
  buildPairKey,
  ChatError,
  cleanShortText,
  CONTACT_REMARK_MAX,
  FRIEND_REQUEST_MESSAGE_MAX,
  FRIEND_REQUEST_REJECT_COOLDOWN_MS,
  FRIEND_REQUEST_TTL_MS,
  FRIEND_REQUESTS_PER_DAY,
  peerFromPairKey,
} from "./domain";
import { ensureProjection, toPublicUser, type PublicUser } from "./projection";
import type { RealtimeBus, RealtimeEvent } from "./realtime";
import { appendEvents, publishCommitted, type PendingEvent } from "./sync";
import { lockPair, withTx, type Tx } from "./tx";

export const FRIEND_SOURCES = ["search", "qr", "link", "profile", "conversation"] as const;
export type FriendSource = (typeof FRIEND_SOURCES)[number];

export type FriendRequestView = {
  id: string;
  status: string;
  direction: "incoming" | "outgoing";
  peer: PublicUser;
  message: string;
  source: string;
  version: number;
  createdAt: string;
  respondedAt: string | null;
  expiresAt: string;
};

export type FriendView = {
  peer: PublicUser;
  remark: string;
  since: string;
  version: number;
  conversationId: string | null;
};

/** 发送申请的结果。界面据此显示「已申请」「对方申请中」「已添加」。 */
export type SendRequestResult =
  | { state: "pending"; request: FriendRequestView }
  | { state: "incoming_pending"; request: FriendRequestView }
  | { state: "already_friends"; conversationId: string | null };

export type Relationship = {
  peer: PublicUser;
  isSelf: boolean;
  friend: boolean;
  outgoing: FriendRequestView | null;
  incoming: FriendRequestView | null;
  blockedByMe: boolean;
  canMessage: boolean;
  conversationId: string | null;
  remark: string;
};

export class FriendService {
  constructor(
    private readonly db: PrismaClient,
    private readonly bus: RealtimeBus,
    private readonly chat: ChatService,
  ) {}

  private async commit<T>(fn: (tx: Tx, events: PendingEvent[]) => Promise<T>): Promise<T> {
    let written: RealtimeEvent[] = [];
    const result = await withTx(this.db, async (tx) => {
      const pending: PendingEvent[] = [];
      const value = await fn(tx, pending);
      written = await appendEvents(tx, pending);
      return value;
    });
    publishCommitted(this.bus, written);
    return result;
  }

  /**
   * A 向 B 发好友申请。
   * - B 必须是账号中心里真实存在的人；不按国家、区号、语言拦截。
   * - 同一 clientRequestId 重试返回同一结果，不生成第二份、不重复通知。
   * - B 已经向 A 申请过：返回那份申请，由 A 明确同意，不自动成为好友。
   * - 被对方拉黑或对方关闭申请：同一句提示，不泄露拉黑。
   */
  async sendRequest(input: {
    requesterSub: string;
    addresseeSub: string;
    message?: string;
    source?: FriendSource;
    clientRequestId?: string | null;
    viaInvite?: boolean;
    now?: Date;
  }): Promise<SendRequestResult> {
    const requester = assertUserPublicId(input.requesterSub);
    const addressee = assertUserPublicId(input.addresseeSub);
    if (requester === addressee) throw new ChatError(400, "不能添加自己为好友");
    const now = input.now || new Date();
    const pairKey = buildPairKey(requester, addressee);
    const message = cleanShortText(input.message, FRIEND_REQUEST_MESSAGE_MAX);
    const clientRequestId = cleanShortText(input.clientRequestId, 80) || null;
    const source = FRIEND_SOURCES.includes(input.source as FriendSource) ? (input.source as FriendSource) : "search";
    await ensureProjection(this.db, addressee, { requireAccount: true, now });
    await ensureProjection(this.db, requester, { requireAccount: false, now });

    return this.commit(async (tx, events) => {
      await lockPair(tx, pairKey);
      if (clientRequestId) {
        const replay = await tx.friendRequest.findUnique({
          where: { requesterSub_clientRequestId: { requesterSub: requester, clientRequestId } },
        });
        if (replay) {
          if (replay.pairKey !== pairKey) throw new ChatError(409, "请求 ID 已用于其他申请");
          return this.resultForExisting(tx, requester, replay);
        }
      }
      const friendship = await tx.friendship.findUnique({ where: { pairKey } });
      if (friendship?.status === "ACTIVE") {
        const conversation = await tx.conversation.findUnique({ where: { directKey: pairKey }, select: { id: true } });
        return { state: "already_friends", conversationId: conversation?.id ?? null } as const;
      }
      const blocks = await tx.userBlock.findMany({
        where: {
          OR: [
            { blockerSub: requester, blockedSub: addressee },
            { blockerSub: addressee, blockedSub: requester },
          ],
        },
      });
      if (blocks.some((row) => row.blockerSub === requester)) throw new ChatError(403, "你已拉黑对方，请先解除拉黑");
      const privacy = await tx.privacySetting.findUnique({ where: { accountSub: addressee } });
      const closed = privacy ? !privacy.allowFriendRequests && !input.viaInvite : false;
      if (blocks.length > 0 || closed) throw new ChatError(403, "对方当前不接受好友申请");

      await this.expireStale(tx, pairKey, now, events);
      const pending = await tx.friendRequest.findUnique({ where: { pendingPairKey: pairKey } });
      if (pending) return this.resultForExisting(tx, requester, pending);

      const lastRejected = await tx.friendRequest.findFirst({
        where: { pairKey, requesterSub: requester, status: "REJECTED" },
        orderBy: { respondedAt: "desc" },
      });
      if (lastRejected?.respondedAt && now.getTime() - lastRejected.respondedAt.getTime() < FRIEND_REQUEST_REJECT_COOLDOWN_MS) {
        throw new ChatError(429, "对方暂时无法接收你的申请，请稍后再试");
      }
      const recent = await tx.friendRequest.count({
        where: { requesterSub: requester, createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      });
      if (recent >= FRIEND_REQUESTS_PER_DAY) throw new ChatError(429, "今天发出的好友申请太多了，请明天再试");

      const created = await tx.friendRequest.create({
        data: {
          id: randomUUID(),
          pairKey,
          requesterSub: requester,
          addresseeSub: addressee,
          status: "PENDING",
          pendingPairKey: pairKey,
          message,
          source,
          clientRequestId,
          expiresAt: new Date(now.getTime() + FRIEND_REQUEST_TTL_MS),
          createdAt: now,
        },
      });
      events.push({
        accountSubs: [requester, addressee],
        kind: "request",
        data: { action: "created", requestId: created.id, requesterSub: requester, addresseeSub: addressee },
      });
      const view = await this.viewRequest(tx, requester, created);
      return { state: "pending", request: view } as const;
    });
  }

  private async resultForExisting(tx: Tx, viewer: string, request: FriendRequest): Promise<SendRequestResult> {
    if (request.status === "ACCEPTED") {
      const friendship = await tx.friendship.findUnique({ where: { pairKey: request.pairKey } });
      if (friendship?.status === "ACTIVE") {
        const conversation = await tx.conversation.findUnique({ where: { directKey: request.pairKey }, select: { id: true } });
        return { state: "already_friends", conversationId: conversation?.id ?? null };
      }
    }
    const view = await this.viewRequest(tx, viewer, request);
    if (request.status === "PENDING" && request.addresseeSub === viewer) return { state: "incoming_pending", request: view };
    return { state: "pending", request: view };
  }

  /** 只有接收者能同意。事务里复查拉黑和申请状态，再建立一条双向关系，并复用原有 DIRECT。 */
  async accept(actorSub: string, requestId: string, now = new Date()) {
    const sub = assertUserPublicId(actorSub);
    const probe = await this.db.friendRequest.findUnique({ where: { id: requestId } });
    if (!probe || (probe.addresseeSub !== sub && probe.requesterSub !== sub)) throw new ChatError(404, "申请不存在");
    return this.commit(async (tx, events) => {
      await lockPair(tx, probe.pairKey);
      const request = await tx.friendRequest.findUniqueOrThrow({ where: { id: requestId } });
      if (request.addresseeSub !== sub) throw new ChatError(403, "只有接收申请的人可以同意");
      if (request.status === "ACCEPTED") {
        const friendship = await tx.friendship.findUnique({ where: { pairKey: request.pairKey } });
        if (friendship?.status === "ACTIVE" && friendship.requestId === request.id) {
          const conversation = await tx.conversation.findUnique({ where: { directKey: request.pairKey }, select: { id: true } });
          return { friendship: friendshipView(friendship), conversationId: conversation?.id ?? null, duplicate: true };
        }
        throw new ChatError(409, "这份申请已失效，请重新发送");
      }
      if (request.status !== "PENDING") throw new ChatError(409, "这份申请已失效");
      if (request.expiresAt.getTime() <= now.getTime()) {
        await this.closeRequest(tx, request, "EXPIRED", now, events);
        throw new ChatError(409, "这份申请已过期");
      }
      const blocked = await tx.userBlock.count({
        where: {
          OR: [
            { blockerSub: request.requesterSub, blockedSub: request.addresseeSub },
            { blockerSub: request.addresseeSub, blockedSub: request.requesterSub },
          ],
        },
      });
      if (blocked > 0) {
        await this.closeRequest(tx, request, "INVALIDATED", now, events);
        throw new ChatError(409, "这份申请已失效");
      }
      const [subA, subB] = request.pairKey.split("__");
      const existing = await tx.friendship.findUnique({ where: { pairKey: request.pairKey } });
      const friendship = existing
        ? await tx.friendship.update({
            where: { pairKey: request.pairKey },
            data: {
              status: "ACTIVE",
              version: { increment: 1 },
              establishedAt: now,
              removedAt: null,
              removedBySub: null,
              requestId: request.id,
            },
          })
        : await tx.friendship.create({
            data: { pairKey: request.pairKey, subA, subB, status: "ACTIVE", establishedAt: now, requestId: request.id },
          });
      await tx.friendRequest.update({
        where: { id: request.id },
        data: { status: "ACCEPTED", pendingPairKey: null, respondedAt: now, version: { increment: 1 } },
      });
      const { conversation } = await this.chat.ensureDirectTx(tx, events, {
        a: request.requesterSub,
        b: request.addresseeSub,
        sourceProduct: "kkchat",
        createdBySub: request.requesterSub,
        now,
      });
      events.push(
        {
          accountSubs: [request.requesterSub, request.addresseeSub],
          kind: "request",
          data: { action: "accepted", requestId: request.id },
        },
        {
          accountSubs: [request.requesterSub, request.addresseeSub],
          kind: "friend",
          conversationId: conversation.id,
          data: { action: "added", pairKey: request.pairKey, version: friendship.version, conversationId: conversation.id },
        },
      );
      return { friendship: friendshipView(friendship), conversationId: conversation.id, duplicate: false };
    });
  }

  async reject(actorSub: string, requestId: string, now = new Date()) {
    return this.closeByActor(actorSub, requestId, "addressee", "REJECTED", now);
  }

  async cancel(actorSub: string, requestId: string, now = new Date()) {
    return this.closeByActor(actorSub, requestId, "requester", "CANCELLED", now);
  }

  private async closeByActor(
    actorSub: string,
    requestId: string,
    role: "addressee" | "requester",
    status: "REJECTED" | "CANCELLED",
    now: Date,
  ) {
    const sub = assertUserPublicId(actorSub);
    const probe = await this.db.friendRequest.findUnique({ where: { id: requestId } });
    if (!probe || (probe.addresseeSub !== sub && probe.requesterSub !== sub)) throw new ChatError(404, "申请不存在");
    return this.commit(async (tx, events) => {
      await lockPair(tx, probe.pairKey);
      const request = await tx.friendRequest.findUniqueOrThrow({ where: { id: requestId } });
      const owner = role === "addressee" ? request.addresseeSub : request.requesterSub;
      if (owner !== sub) throw new ChatError(403, role === "addressee" ? "只有接收者可以拒绝" : "只有发起人可以撤销");
      if (request.status === status) return { status, duplicate: true };
      if (request.status !== "PENDING") throw new ChatError(409, "这份申请已处理");
      await this.closeRequest(tx, request, status, now, events);
      return { status, duplicate: false };
    });
  }

  /** 删除好友：双方关系一起解除，聊天记录保留，兼容授权撤销。旧申请和迟到的重试不能恢复关系。 */
  async remove(actorSub: string, peerSub: string, now = new Date()) {
    const sub = assertUserPublicId(actorSub);
    const peer = assertUserPublicId(peerSub);
    const pairKey = buildPairKey(sub, peer);
    return this.commit(async (tx, events) => {
      await lockPair(tx, pairKey);
      const removed = await this.removeFriendshipTx(tx, pairKey, sub, now, events);
      await this.invalidatePending(tx, pairKey, now, events);
      const revoked = await revokeGrants(tx, pairKey, "friend_removed", now);
      if (revoked > 0) await this.pushAccessChanged(tx, pairKey, events);
      return { removed };
    });
  }

  /** 拉黑：屏蔽之后的个人私聊和申请；未决申请失效；已有好友关系解除。不自动退群。 */
  async block(actorSub: string, targetSub: string, now = new Date()) {
    const sub = assertUserPublicId(actorSub);
    const target = assertUserPublicId(targetSub);
    const pairKey = buildPairKey(sub, target);
    await ensureProjection(this.db, target, { requireAccount: false, now });
    return this.commit(async (tx, events) => {
      await lockPair(tx, pairKey);
      const existing = await tx.userBlock.findUnique({
        where: { blockerSub_blockedSub: { blockerSub: sub, blockedSub: target } },
      });
      if (!existing) {
        await tx.userBlock.create({ data: { id: randomUUID(), blockerSub: sub, blockedSub: target, createdAt: now } });
      }
      await this.removeFriendshipTx(tx, pairKey, sub, now, events);
      await this.invalidatePending(tx, pairKey, now, events);
      const revoked = await revokeGrants(tx, pairKey, "blocked", now);
      if (revoked > 0) await this.pushAccessChanged(tx, pairKey, events);
      events.push({ accountSubs: [sub], kind: "block", data: { action: "blocked", targetSub: target } });
      return { blocked: true, duplicate: Boolean(existing) };
    });
  }

  /** 解除拉黑不恢复好友、不恢复失效申请、不补发拉黑期间的消息。 */
  async unblock(actorSub: string, targetSub: string) {
    const sub = assertUserPublicId(actorSub);
    const target = assertUserPublicId(targetSub);
    const pairKey = buildPairKey(sub, target);
    return this.commit(async (tx, events) => {
      await lockPair(tx, pairKey);
      const result = await tx.userBlock.deleteMany({ where: { blockerSub: sub, blockedSub: target } });
      if (result.count > 0) {
        events.push({ accountSubs: [sub], kind: "block", data: { action: "unblocked", targetSub: target } });
        await this.pushAccessChanged(tx, pairKey, events, [sub]);
      }
      return { unblocked: result.count > 0 };
    });
  }

  async listFriends(accountSub: string): Promise<FriendView[]> {
    const sub = assertUserPublicId(accountSub);
    const rows = await this.db.friendship.findMany({
      where: { status: "ACTIVE", OR: [{ subA: sub }, { subB: sub }] },
      orderBy: { establishedAt: "desc" },
    });
    const peers = rows.map((row) => (row.subA === sub ? row.subB : row.subA));
    const [users, notes, conversations] = await Promise.all([
      this.db.userProjection.findMany({ where: { accountSub: { in: peers } } }),
      this.db.contactNote.findMany({ where: { ownerSub: sub, targetSub: { in: peers } } }),
      this.db.conversation.findMany({ where: { directKey: { in: rows.map((row) => row.pairKey) } }, select: { id: true, directKey: true } }),
    ]);
    const userMap = new Map(users.map((user) => [user.accountSub, user]));
    const noteMap = new Map(notes.map((note) => [note.targetSub, note.remark]));
    const convMap = new Map(conversations.map((conv) => [conv.directKey, conv.id]));
    return rows.map((row) => {
      const peer = row.subA === sub ? row.subB : row.subA;
      return {
        peer: toPublicUser(userMap.get(peer) ?? null, peer),
        remark: noteMap.get(peer) || "",
        since: row.establishedAt.toISOString(),
        version: row.version,
        conversationId: convMap.get(row.pairKey) ?? null,
      };
    });
  }

  async listRequests(accountSub: string, now = new Date()) {
    const sub = assertUserPublicId(accountSub);
    const rows = await this.db.friendRequest.findMany({
      where: { OR: [{ addresseeSub: sub }, { requesterSub: sub }], status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const live = rows.filter((row) => row.expiresAt.getTime() > now.getTime());
    const views = await Promise.all(live.map((row) => this.viewRequest(this.db, sub, row)));
    return {
      incoming: views.filter((view) => view.direction === "incoming"),
      outgoing: views.filter((view) => view.direction === "outgoing"),
    };
  }

  async listBlocks(accountSub: string) {
    const sub = assertUserPublicId(accountSub);
    const rows = await this.db.userBlock.findMany({ where: { blockerSub: sub }, orderBy: { createdAt: "desc" } });
    const users = await this.db.userProjection.findMany({ where: { accountSub: { in: rows.map((row) => row.blockedSub) } } });
    const map = new Map(users.map((user) => [user.accountSub, user]));
    return rows.map((row) => ({ peer: toPublicUser(map.get(row.blockedSub) ?? null, row.blockedSub), since: row.createdAt.toISOString() }));
  }

  /** 备注只属于自己，不覆盖对方公开资料。只能给好友或已有私聊的人写备注。 */
  async setRemark(ownerSub: string, targetSub: string, remark: string) {
    const owner = assertUserPublicId(ownerSub);
    const target = assertUserPublicId(targetSub);
    const pairKey = buildPairKey(owner, target);
    const value = cleanShortText(remark, CONTACT_REMARK_MAX);
    const [friendship, conversation] = await Promise.all([
      this.db.friendship.findUnique({ where: { pairKey } }),
      this.db.conversation.findUnique({ where: { directKey: pairKey }, select: { id: true } }),
    ]);
    if (friendship?.status !== "ACTIVE" && !conversation) throw new ChatError(403, "只能给好友设置备注");
    return this.commit(async (tx, events) => {
      await tx.contactNote.upsert({
        where: { ownerSub_targetSub: { ownerSub: owner, targetSub: target } },
        create: { id: randomUUID(), ownerSub: owner, targetSub: target, remark: value },
        update: { remark: value },
      });
      events.push({ accountSubs: [owner], kind: "friend", data: { action: "remark", peerSub: target, remark: value } });
      return { remark: value };
    });
  }

  async relationship(viewerSub: string, targetSub: string, now = new Date()): Promise<Relationship> {
    const viewer = assertUserPublicId(viewerSub);
    const target = assertUserPublicId(targetSub);
    const projection = await ensureProjection(this.db, target, { requireAccount: viewer !== target, now });
    const peer = toPublicUser(projection, target);
    if (viewer === target) {
      return { peer, isSelf: true, friend: false, outgoing: null, incoming: null, blockedByMe: false, canMessage: false, conversationId: null, remark: "" };
    }
    const pairKey = buildPairKey(viewer, target);
    const [friendship, pending, blockedByMe, blockedMe, grant, conversation, note] = await Promise.all([
      this.db.friendship.findUnique({ where: { pairKey } }),
      this.db.friendRequest.findUnique({ where: { pendingPairKey: pairKey } }),
      this.db.userBlock.findUnique({ where: { blockerSub_blockedSub: { blockerSub: viewer, blockedSub: target } } }),
      this.db.userBlock.findUnique({ where: { blockerSub_blockedSub: { blockerSub: target, blockedSub: viewer } } }),
      this.db.directGrant.findFirst({ where: { pairKey, revokedAt: null } }),
      this.db.conversation.findUnique({ where: { directKey: pairKey }, select: { id: true } }),
      this.db.contactNote.findUnique({ where: { ownerSub_targetSub: { ownerSub: viewer, targetSub: target } } }),
    ]);
    const livePending = pending && pending.expiresAt.getTime() > now.getTime() ? pending : null;
    const pendingView = livePending ? await this.viewRequest(this.db, viewer, livePending) : null;
    const friend = friendship?.status === "ACTIVE";
    return {
      peer,
      isSelf: false,
      friend,
      outgoing: pendingView?.direction === "outgoing" ? pendingView : null,
      incoming: pendingView?.direction === "incoming" ? pendingView : null,
      blockedByMe: Boolean(blockedByMe),
      canMessage: !blockedByMe && !blockedMe && (friend || Boolean(grant)),
      conversationId: conversation?.id ?? null,
      remark: note?.remark || "",
    };
  }

  private async removeFriendshipTx(tx: Tx, pairKey: string, actor: string, now: Date, events: PendingEvent[]) {
    const friendship = await tx.friendship.findUnique({ where: { pairKey } });
    if (friendship?.status !== "ACTIVE") return false;
    const updated = await tx.friendship.update({
      where: { pairKey },
      data: { status: "REMOVED", version: { increment: 1 }, removedAt: now, removedBySub: actor },
    });
    events.push({
      accountSubs: [updated.subA, updated.subB],
      kind: "friend",
      data: { action: "removed", pairKey, version: updated.version },
    });
    return true;
  }

  private async invalidatePending(tx: Tx, pairKey: string, now: Date, events: PendingEvent[]) {
    const pending = await tx.friendRequest.findUnique({ where: { pendingPairKey: pairKey } });
    if (pending) await this.closeRequest(tx, pending, "INVALIDATED", now, events);
  }

  private async expireStale(tx: Tx, pairKey: string, now: Date, events: PendingEvent[]) {
    const pending = await tx.friendRequest.findUnique({ where: { pendingPairKey: pairKey } });
    if (pending && pending.expiresAt.getTime() <= now.getTime()) await this.closeRequest(tx, pending, "EXPIRED", now, events);
  }

  private async closeRequest(tx: Tx, request: FriendRequest, status: string, now: Date, events: PendingEvent[]) {
    const closed = await tx.friendRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: { status, pendingPairKey: null, respondedAt: now, version: { increment: 1 } },
    });
    if (closed.count === 1) {
      events.push({
        accountSubs: [request.requesterSub, request.addresseeSub],
        kind: "request",
        data: { action: status.toLowerCase(), requestId: request.id },
      });
    }
  }

  private async pushAccessChanged(tx: Tx, pairKey: string, events: PendingEvent[], only?: string[]) {
    const conversation = await tx.conversation.findUnique({ where: { directKey: pairKey }, select: { id: true } });
    if (!conversation) return;
    events.push({
      accountSubs: only ?? pairKey.split("__"),
      kind: "conversation",
      conversationId: conversation.id,
      data: { action: "access_changed", conversationId: conversation.id },
    });
  }

  private async viewRequest(
    client: Tx | PrismaClient,
    viewer: string,
    request: FriendRequest,
  ): Promise<FriendRequestView> {
    const direction = request.addresseeSub === viewer ? "incoming" : "outgoing";
    const peerSub = peerFromPairKey(request.pairKey, viewer);
    const user = await client.userProjection.findUnique({ where: { accountSub: peerSub } });
    return {
      id: request.id,
      status: request.status,
      direction,
      peer: toPublicUser(user, peerSub),
      message: request.message,
      source: request.source,
      version: request.version,
      createdAt: request.createdAt.toISOString(),
      respondedAt: request.respondedAt?.toISOString() ?? null,
      expiresAt: request.expiresAt.toISOString(),
    };
  }
}

function friendshipView(friendship: { pairKey: string; status: string; version: number; establishedAt: Date }) {
  return {
    pairKey: friendship.pairKey,
    status: friendship.status,
    version: friendship.version,
    establishedAt: friendship.establishedAt.toISOString(),
  };
}
