import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { buildPairKey } from "../src/lib/domain";
import { createInvite, createReport, listReportsForModerator, resolveInvite, resolveReport, searchUsers, updatePrivacy } from "../src/lib/social";
import { befriend, CN_A, db, directory, INTL_B, INTL_D, NEW_E, resetDb, seedProjection, services, THIRD_C } from "./support";

const A = CN_A;
const B = INTL_B;
const C = THIRD_C;
const user = (sub: string) => ({ kind: "user" as const, sub });

beforeEach(resetDb);

test("G01 国内用户与境外用户两个方向都能互加，没有地区条件，只有一条有效关系", async () => {
  const { friends } = services();
  const first = await friends.sendRequest({ requesterSub: A, addresseeSub: B, message: "Hi from Shanghai" });
  assert.equal(first.state, "pending");
  const accepted = await friends.accept(B, first.state === "pending" ? first.request.id : "");
  assert.ok(accepted.conversationId);
  const reverse = await friends.sendRequest({ requesterSub: INTL_D, addresseeSub: A, message: "こんにちは" });
  assert.equal(reverse.state, "pending");
  await friends.accept(A, reverse.state === "pending" ? reverse.request.id : "");
  assert.equal(await db.friendship.count({ where: { status: "ACTIVE" } }), 2);
  assert.equal(await db.friendship.count({ where: { pairKey: buildPairKey(A, B) } }), 1);
  const listA = await friends.listFriends(A);
  assert.deepEqual(listA.map((item) => item.peer.accountSub).sort(), [B, INTL_D].sort());
  assert.equal(listA.find((item) => item.peer.accountSub === B)?.peer.displayName, "María López 🌍");
});

test("F01 重复点击、超时重试、双向同时申请：一个未决申请，同意后一个关系一个私聊", async () => {
  const { friends } = services();
  const clientRequestId = randomUUID();
  const repeats = await Promise.all(
    Array.from({ length: 5 }, () => friends.sendRequest({ requesterSub: A, addresseeSub: B, clientRequestId })),
  );
  const ids = new Set(repeats.map((item) => (item.state === "already_friends" ? "" : item.request.id)));
  assert.equal(ids.size, 1);
  const noKey = await Promise.all(Array.from({ length: 4 }, () => friends.sendRequest({ requesterSub: A, addresseeSub: B })));
  assert.equal(new Set(noKey.map((item) => (item.state === "already_friends" ? "" : item.request.id))).size, 1);
  assert.equal(await db.friendRequest.count({ where: { status: "PENDING" } }), 1);

  const reverse = await friends.sendRequest({ requesterSub: B, addresseeSub: A });
  assert.equal(reverse.state, "incoming_pending");
  assert.equal(await db.friendRequest.count(), 1);
  assert.equal(await db.friendship.count(), 0);

  const requestId = [...ids][0];
  const results = await Promise.allSettled([friends.accept(B, requestId), friends.accept(B, requestId), friends.accept(B, requestId)]);
  const ok = results.filter((item) => item.status === "fulfilled").map((item) => (item as PromiseFulfilledResult<{ conversationId: string | null }>).value);
  assert.equal(ok.length, 3);
  assert.equal(new Set(ok.map((item) => item.conversationId)).size, 1);
  assert.equal(await db.friendship.count({ where: { status: "ACTIVE" } }), 1);
  assert.equal(await db.conversation.count({ where: { kind: "DIRECT" } }), 1);
  const again = await friends.sendRequest({ requesterSub: A, addresseeSub: B });
  assert.equal(again.state, "already_friends");
});

test("F02 同意与撤销并发、同意与拉黑并发：按事务顺序收敛，旧请求不能复活关系", async () => {
  const { friends } = services();
  for (let round = 0; round < 3; round += 1) {
    await resetDb();
    const sent = await friends.sendRequest({ requesterSub: A, addresseeSub: B });
    const id = sent.state === "pending" ? sent.request.id : "";
    const [accept, cancel] = await Promise.allSettled([friends.accept(B, id), friends.cancel(A, id)]);
    const request = await db.friendRequest.findUniqueOrThrow({ where: { id } });
    const friendship = await db.friendship.findUnique({ where: { pairKey: buildPairKey(A, B) } });
    if (accept.status === "fulfilled") {
      assert.equal(request.status, "ACCEPTED");
      assert.equal(friendship?.status, "ACTIVE");
      assert.equal(cancel.status, "rejected");
    } else {
      assert.equal(request.status, "CANCELLED");
      assert.equal(friendship, null);
    }
  }
  await resetDb();
  const sent = await friends.sendRequest({ requesterSub: A, addresseeSub: B });
  const id = sent.state === "pending" ? sent.request.id : "";
  await Promise.allSettled([friends.accept(B, id), friends.block(A, B)]);
  const friendship = await db.friendship.findUnique({ where: { pairKey: buildPairKey(A, B) } });
  assert.notEqual(friendship?.status, "ACTIVE");
  assert.equal(await db.userBlock.count({ where: { blockerSub: A, blockedSub: B } }), 1);
  await assert.rejects(() => friends.accept(B, id));
  const { chat } = services();
  const conversation = await db.conversation.findUnique({ where: { directKey: buildPairKey(A, B) } });
  if (conversation) {
    await assert.rejects(() => chat.sendMessage({ actor: user(B), senderSub: B, conversationId: conversation.id, body: "hi" }), /还不是好友/);
  }
});

test("F03 第三人不能代同意、代拒绝、改目标资料", async () => {
  const { friends, chat } = services();
  const sent = await friends.sendRequest({ requesterSub: A, addresseeSub: B });
  const id = sent.state === "pending" ? sent.request.id : "";
  await assert.rejects(() => friends.accept(C, id), /申请不存在/);
  await assert.rejects(() => friends.reject(C, id), /申请不存在/);
  await assert.rejects(() => friends.accept(A, id), /只有接收申请的人可以同意/);
  await assert.rejects(() => friends.cancel(B, id), /只有发起人可以撤销/);
  assert.equal((await db.friendRequest.findUniqueOrThrow({ where: { id } })).status, "PENDING");

  await friends.relationship(A, B);
  const before = await db.userProjection.findUniqueOrThrow({ where: { accountSub: B } });
  assert.equal(before.displayName, "María López 🌍");
  assert.equal(before.profileSource, "ACCOUNT");
  await chat.openDirectForService({ product: "main", senderSub: C, recipientSub: B, recipientHintName: "冒名顶替" });
  const after = await db.userProjection.findUniqueOrThrow({ where: { accountSub: B } });
  assert.equal(after.displayName, "María López 🌍");
});

test("F04 删除好友保留历史；旧申请不能恢复；重新申请后复用原私聊", async () => {
  const { friends, chat } = services();
  const sent = await friends.sendRequest({ requesterSub: A, addresseeSub: B });
  const oldId = sent.state === "pending" ? sent.request.id : "";
  const { conversationId } = await friends.accept(B, oldId);
  await chat.sendMessage({ actor: user(A), senderSub: A, conversationId: conversationId!, body: "第一句" });
  await friends.remove(A, B);
  await assert.rejects(() => chat.sendMessage({ actor: user(B), senderSub: B, conversationId: conversationId!, body: "还在吗" }), /还不是好友/);
  assert.equal((await chat.getThread(B, conversationId!)).messages.length, 1);
  await assert.rejects(() => friends.accept(B, oldId), /失效/);
  assert.notEqual((await db.friendship.findUniqueOrThrow({ where: { pairKey: buildPairKey(A, B) } })).status, "ACTIVE");
  const again = await friends.sendRequest({ requesterSub: B, addresseeSub: A });
  const readded = await friends.accept(A, again.state === "pending" ? again.request.id : "");
  assert.equal(readded.conversationId, conversationId);
  assert.equal(await db.conversation.count({ where: { kind: "DIRECT" } }), 1);
  assert.equal((await chat.getThread(A, conversationId!)).messages.length, 1);
  const friendship = await db.friendship.findUniqueOrThrow({ where: { pairKey: buildPairKey(A, B) } });
  assert.equal(friendship.status, "ACTIVE");
  assert.equal(friendship.version, 3);
});

test("F05 被拉黑者从用户接口和产品服务接口都发不出个人消息；解除拉黑不恢复好友", async () => {
  const { friends, chat } = services();
  const conversationId = await befriend(friends, A, B);
  await friends.block(B, A);
  await assert.rejects(() => chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "hi" }), /还不是好友/);
  await assert.rejects(
    () => chat.sendMessage({ actor: { kind: "service", product: "academic" }, senderSub: A, recipientSub: B, body: "教务名义", idempotencyKey: "x1" }),
    /暂时无法给对方发送个人消息/,
  );
  await assert.rejects(
    () => chat.sendMessage({ actor: { kind: "service", product: "main" }, senderSub: A, conversationId, body: "主站名义", idempotencyKey: "x2" }),
    /还不是好友|暂时无法/,
  );
  await assert.rejects(() => chat.sendMessage({ actor: user(B), senderSub: B, conversationId, body: "我拉黑了你" }), /你已拉黑对方/);
  await assert.rejects(() => friends.sendRequest({ requesterSub: A, addresseeSub: B }), /对方当前不接受好友申请/);
  await friends.unblock(B, A);
  assert.notEqual((await db.friendship.findUniqueOrThrow({ where: { pairKey: buildPairKey(A, B) } })).status, "ACTIVE");
  await assert.rejects(() => chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "hi" }), /还不是好友/);
  const rel = await friends.relationship(A, B);
  assert.equal(rel.friend, false);
  assert.equal(rel.blockedByMe, false);
});

test("拉黑不自动退群，群里的消息照常可以发", async () => {
  const { friends, chat } = services();
  await befriend(friends, A, B);
  await befriend(friends, A, C);
  const group = await chat.createGroup({ creatorSub: A, title: "同学群", memberSubs: [B, C] });
  await friends.block(B, C);
  const sent = await chat.sendMessage({ actor: user(C), senderSub: C, conversationId: group.id, body: "群里说话" });
  assert.equal(sent.message.seq, 1);
  await assert.rejects(() => chat.createGroup({ creatorSub: B, title: "x", memberSubs: [C] }), /只能把好友拉进群聊/);
  await assert.rejects(() => chat.createGroup({ creatorSub: C, title: "x", memberSubs: [INTL_D] }), /只能把好友拉进群聊/);
});

test("升级前已有的私聊有兼容授权可继续聊；删除或拉黑后授权失效；普通用户不能直接开启新私聊", async () => {
  const { friends, chat } = services();
  const legacy = await chat.openDirectForService({ product: "main", senderSub: A, recipientSub: B });
  await db.directGrant.updateMany({ data: { kind: "LEGACY" } });
  const reply = await chat.sendMessage({ actor: user(B), senderSub: B, conversationId: legacy.conversation.id, body: "收到" });
  assert.equal(reply.message.seq, 1);
  assert.equal((await chat.listInbox(B))[0].relation, "grant");
  await friends.remove(B, A);
  assert.equal(await db.directGrant.count({ where: { revokedAt: null } }), 0);
  await assert.rejects(() => chat.sendMessage({ actor: user(B), senderSub: B, conversationId: legacy.conversation.id, body: "再说" }), /还不是好友/);
  await assert.rejects(() => chat.openDirectForUser(C, A), /还不是好友/);
});

test("G03 KK 号、账号、二维码链接找同一个人；同名可辨别；链接不授予读取权", async () => {
  const { friends, chat } = services();
  const byKk = await searchUsers(db, C, { kkNumber: "10002" });
  const byUsername = await searchUsers(db, C, { username: "maria_lopez" });
  assert.equal(byKk[0].accountSub, B);
  assert.equal(byUsername[0].accountSub, B);
  const sameName = await searchUsers(db, C, { q: "小文" });
  assert.equal(sameName.length, 2);
  assert.notEqual(sameName[0].kkNumber, sameName[1].kkNumber);
  const invite = await createInvite(db, B);
  assert.equal(invite.url.startsWith("https://kkchat.test/i/"), true);
  assert.equal(/session|refresh|token=/i.test(invite.url.replace(invite.token, "")), false);
  const resolved = await resolveInvite(db, invite.token);
  assert.equal(resolved.owner.accountSub, B);
  const conversationId = await befriend(friends, A, B);
  await assert.rejects(() => chat.getThread(C, conversationId), /不能查看这个会话/);
  const rel = await friends.relationship(C, B);
  assert.equal(rel.friend, false);
});

test("可发现性设置与拉黑影响搜索结果", async () => {
  const { friends } = services();
  await updatePrivacy(db, B, { discoverByKkNumber: false, discoverByName: false });
  assert.equal((await searchUsers(db, C, { kkNumber: "10002" })).length, 0);
  assert.equal((await searchUsers(db, C, { q: "María" })).length, 0);
  assert.equal((await searchUsers(db, C, { username: "maria_lopez" })).length, 1);
  await friends.block(INTL_D, C);
  assert.equal((await searchUsers(db, C, { kkNumber: "10004" })).length, 0);
  assert.equal((await searchUsers(db, A, { kkNumber: "10004" }))[0].relation, "none");
  await updatePrivacy(db, B, { allowFriendRequests: false });
  await assert.rejects(() => friends.sendRequest({ requesterSub: C, addresseeSub: B }), /对方当前不接受好友申请/);
  const invite = await createInvite(db, B);
  const viaInvite = await friends.sendRequest({ requesterSub: C, addresseeSub: (await resolveInvite(db, invite.token)).owner.accountSub, viaInvite: true });
  assert.equal(viaInvite.state, "pending");
});

test("G04 从没打开过 KKChat 的账号中心新用户也能被找到并收到申请", async () => {
  const { friends } = services();
  assert.equal(await db.userProjection.count({ where: { accountSub: NEW_E } }), 0);
  const hits = await searchUsers(db, A, { kkNumber: "10005" });
  assert.equal(hits[0].accountSub, NEW_E);
  const sent = await friends.sendRequest({ requesterSub: A, addresseeSub: NEW_E });
  assert.equal(sent.state, "pending");
  const projection = await db.userProjection.findUniqueOrThrow({ where: { accountSub: NEW_E } });
  assert.equal(projection.profileSource, "ACCOUNT");
  assert.equal(projection.kkNumber, 10005);
  const incoming = await friends.listRequests(NEW_E);
  assert.equal(incoming.incoming.length, 1);
  assert.equal(incoming.incoming[0].peer.displayName, "小文");
});

test("不存在的账号、自己、目录不可用时不伪造用户", async () => {
  const { friends } = services();
  const ghost = "usr_0123456789ABCDEFGHJKMNPQRZ";
  await assert.rejects(() => friends.sendRequest({ requesterSub: A, addresseeSub: ghost }), /用户不存在/);
  await assert.rejects(() => friends.sendRequest({ requesterSub: A, addresseeSub: A }), /不能添加自己/);
  directory.failing = true;
  await assert.rejects(() => friends.sendRequest({ requesterSub: A, addresseeSub: INTL_D }), /账号目录暂时不可用/);
  assert.equal(await db.userProjection.count({ where: { accountSub: ghost } }), 0);
});

test("被拒绝后一天内不能重复骚扰；拒绝与撤销重复调用无副作用", async () => {
  const { friends } = services();
  const sent = await friends.sendRequest({ requesterSub: A, addresseeSub: B });
  const id = sent.state === "pending" ? sent.request.id : "";
  await friends.reject(B, id);
  const again = await friends.reject(B, id);
  assert.equal(again.duplicate, true);
  await assert.rejects(() => friends.sendRequest({ requesterSub: A, addresseeSub: B }), /稍后再试/);
  const later = await friends.sendRequest({ requesterSub: A, addresseeSub: B, now: new Date(Date.now() + 25 * 60 * 60 * 1000) });
  assert.equal(later.state, "pending");
  const cancelled = await friends.cancel(A, later.state === "pending" ? later.request.id : "");
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal((await friends.cancel(A, later.state === "pending" ? later.request.id : "")).duplicate, true);
});

test("备注只属于自己，不改对方公开资料", async () => {
  const { friends, chat } = services();
  await befriend(friends, A, B);
  await friends.setRemark(A, B, "西班牙同学");
  assert.equal((await chat.listInbox(A))[0].title, "西班牙同学");
  assert.equal((await chat.listInbox(B))[0].title, "小文");
  assert.equal((await db.userProjection.findUniqueOrThrow({ where: { accountSub: B } })).displayName, "María López 🌍");
  await assert.rejects(() => friends.setRemark(A, C, "x"), /只能给好友设置备注/);
});

test("F06 举报落库并留快照；只有审核人能处理；第三人读不到", async () => {
  const { friends, chat } = services();
  const conversationId = await befriend(friends, A, B);
  const sent = await chat.sendMessage({ actor: user(B), senderSub: B, conversationId, body: "可疑链接 http://scam.example" });
  const report = await createReport(db, { reporterSub: A, targetSub: B, reason: "fraud", messageId: sent.message.id, detail: "骗钱" });
  assert.equal(report.status, "OPEN");
  await chat.recall(B, sent.message.id);
  const row = await db.userReport.findUniqueOrThrow({ where: { id: report.id } });
  assert.match(row.messageSnapshot, /scam\.example/);
  await assert.rejects(() => createReport(db, { reporterSub: C, targetSub: B, reason: "spam", messageId: sent.message.id }), /只能举报自己所在会话/);
  await assert.rejects(() => listReportsForModerator(db, C), /没有审核权限/);
  process.env.KKCHAT_MODERATOR_SUBS = INTL_D;
  await seedProjection(INTL_D, "审核员");
  const open = await listReportsForModerator(db, INTL_D);
  assert.equal(open.length, 1);
  await assert.rejects(() => resolveReport(db, C, report.id, { status: "RESOLVED" }), /没有审核权限/);
  await resolveReport(db, INTL_D, report.id, { status: "RESOLVED", resolution: "已警告" });
  assert.equal((await db.userReport.findUniqueOrThrow({ where: { id: report.id } })).status, "RESOLVED");
  delete process.env.KKCHAT_MODERATOR_SUBS;
});

test.after(async () => {
  await db.$disconnect();
});
