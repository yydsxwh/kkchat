import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { authorizeService } from "../src/lib/http";
import {
  buildDirectKey,
  canRecall,
  messagePreview,
  parseDirectoryQuery,
  projectionFromClaims,
  sanitizeMessageBody,
} from "../src/lib/domain";
import { createPkcePair, signPayload, verifyPayload } from "../src/lib/crypto";
import { assertOidcStart, startOidc, verifyIdToken } from "../src/lib/oidc";
import { MemoryRealtimeBus } from "../src/lib/realtime";
import { shouldNotifyWechat, wechatExcerpt } from "../src/lib/wechat-policy";
import { plan } from "../scripts/migrate-legacy-chat";
import { befriend, CN_A, db, INTL_B, resetDb, services, THIRD_C } from "./support";

const A = CN_A;
const B = INTL_B;
const C = THIRD_C;
const user = (sub: string) => ({ kind: "user" as const, sub });

beforeEach(resetDb);

test("directKey 与发起顺序、产品入口无关", () => {
  assert.equal(buildDirectKey(A, B), buildDirectKey(B, A));
  assert.throws(() => buildDirectKey(A, A));
});

test("同一对账号从主站和教务进入，仍是同一个私聊", async () => {
  const { chat } = services();
  const fromMain = await chat.openDirectForService({ product: "main", senderSub: A, recipientSub: B });
  const fromAcademic = await chat.openDirectForService({ product: "academic", senderSub: B, recipientSub: A });
  assert.equal(fromMain.conversation.id, fromAcademic.conversation.id);
  await chat.sendMessage({ actor: { kind: "service", product: "main" }, senderSub: A, recipientSub: B, body: "来自主站", idempotencyKey: "m1" });
  await chat.sendMessage({
    actor: { kind: "service", product: "academic" },
    senderSub: A,
    conversationId: fromAcademic.conversation.id,
    body: "来自教务",
    idempotencyKey: "a1",
  });
  const thread = await chat.getThread(B, fromMain.conversation.id);
  assert.equal(thread.messages.length, 2);
  assert.deepEqual(thread.messages.map((item) => item.sourceProduct), ["main", "academic"]);
  assert.deepEqual(thread.messages.map((item) => item.seq), [1, 2]);
});

test("不是成员不能读会话", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  await assert.rejects(() => chat.getThread(C, conversationId), /不能查看这个会话/);
  await assert.rejects(() => chat.listMessages(C, conversationId), /不能查看这个会话/);
});

test("未读增加，打开后清零，对方看到已读", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "在吗" });
  const inbox = await chat.listInbox(B);
  assert.equal(inbox[0]?.unreadCount, 1);
  assert.equal(await chat.totalUnread(B), 1);
  assert.equal((await chat.getThread(A, conversationId)).messages[0]?.read, false);
  await chat.markRead(B, conversationId);
  assert.equal(await chat.totalUnread(B), 0);
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 0);
  assert.equal((await chat.getThread(A, conversationId)).messages[0]?.read, true);
});

test("相同 clientMessageId 不会写成两条，并发重放也只落一次", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "只发一次", idempotencyKey: "same-client-id" }),
    ),
  );
  assert.equal(new Set(results.map((item) => item.message.id)).size, 1);
  assert.equal(results.filter((item) => !item.duplicate).length, 1);
  assert.equal(await db.message.count({ where: { conversationId } }), 1);
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 1);
});

test("并发发送：会话序号连续不重复，未读计数不丢", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: `第 ${index} 条`, idempotencyKey: `c-${index}` }),
    ),
  );
  const seqs = (await db.message.findMany({ where: { conversationId }, orderBy: { seq: "asc" } })).map((row) => row.seq);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 20);
});

test("旧的已读请求不会把后来的新消息清零；历史超过 100 条可以继续分页", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  for (let index = 0; index < 120; index += 1) {
    await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: `m${index}`, idempotencyKey: `h-${index}` });
  }
  await chat.markRead(B, conversationId, 110);
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 10);
  await chat.markRead(B, conversationId, 50);
  const after = await chat.listInbox(B);
  assert.equal(after[0]?.unreadCount, 10);
  assert.equal(after[0]?.lastReadSeq, 110);

  const [send] = await Promise.all([
    chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "新消息", idempotencyKey: "late" }),
    chat.markRead(B, conversationId, 110),
  ]);
  assert.equal(send.message.seq, 121);
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 11);

  const first = await chat.listMessages(B, conversationId, { limit: 50 });
  assert.equal(first.messages.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(first.messages[0].seq, 72);
  const second = await chat.listMessages(B, conversationId, { beforeSeq: first.messages[0].seq, limit: 50 });
  assert.equal(second.messages.at(-1)?.seq, 71);
  const third = await chat.listMessages(B, conversationId, { beforeSeq: second.messages[0].seq, limit: 50 });
  assert.equal(third.messages[0].seq, 1);
  assert.equal(third.hasMore, false);
  const newer = await chat.listMessages(B, conversationId, { afterSeq: 118 });
  assert.deepEqual(newer.messages.map((item) => item.seq), [119, 120, 121]);
});

test("两分钟内可撤回自己的消息，超时或别人的消息不行；撤回后未读回退", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  const sentAt = new Date(Date.now() - 1000);
  const sent = await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "说错了", now: sentAt });
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 1);
  await assert.rejects(() => chat.recall(B, sent.message.id, new Date(sentAt.getTime() + 1000)));
  const recalled = await chat.recall(A, sent.message.id, new Date(sentAt.getTime() + 30_000));
  assert.equal(recalled.body, null);
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 0);
  await assert.rejects(() => chat.recall(A, sent.message.id, new Date(sentAt.getTime() + 40_000)));
  const late = await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "太晚了", now: sentAt });
  await assert.rejects(() => chat.recall(A, late.message.id, new Date(sentAt.getTime() + 3 * 60 * 1000)));
  assert.equal(canRecall({ senderSub: A, createdAt: sentAt, recalledAt: null }, B, sentAt), false);
});

test("普通用户不能伪造 SYSTEM 类型，也不能代替别人发消息", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  await assert.rejects(
    () => chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "系统通知", type: "SYSTEM" }),
    /不支持的消息类型/,
  );
  await assert.rejects(() => chat.sendMessage({ actor: user(C), senderSub: A, conversationId, body: "冒充" }), /不能代替别人/);
  await assert.rejects(() => chat.sendMessage({ actor: user(C), senderSub: C, conversationId, body: "闯入" }), /不能在这个会话发消息/);
});

test("消息按纯文本保存，超长会被拒绝；中文、外文和 emoji 不乱码", async () => {
  assert.equal(sanitizeMessageBody("  <b>你好</b>  "), "<b>你好</b>");
  assert.equal(messagePreview("x".repeat(100), false).endsWith("…"), true);
  assert.throws(() => sanitizeMessageBody(""));
  assert.throws(() => sanitizeMessageBody("x".repeat(4001)));
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  const text = "Hola 👋 こんにちは 你好 Привет";
  await chat.sendMessage({ actor: user(B), senderSub: B, conversationId, body: text });
  assert.equal((await chat.getThread(A, conversationId)).messages[0].body, text);
});

test("账号声明映射成最小投影", () => {
  const draft = projectionFromClaims({
    sub: A,
    name: "小文",
    picture: "https://cdn.example/a.png",
    username: "xiaowen",
    kk_number: 10086,
    role: "STUDENT",
    email: "secret@example.com",
    phone_number: "13800000000",
  } as never);
  assert.equal(draft.accountSub, A);
  assert.equal(draft.kkNumber, 10086);
  assert.equal(draft.username, "xiaowen");
  assert.equal(draft.displayName, "小文");
  assert.equal("email" in draft, false);
  assert.equal("phone_number" in draft, false);
});

test("KK 号搜索只接受精确数字，空搜索被拒绝", () => {
  assert.deepEqual(parseDirectoryQuery({ kkNumber: "10086" }), { kind: "kk", kkNumber: 10086 });
  assert.deepEqual(parseDirectoryQuery({ username: "XiaoWen" }), { kind: "username", username: "xiaowen" });
  assert.equal(parseDirectoryQuery({ q: "小文" }).kind, "name");
  assert.throws(() => parseDirectoryQuery({}));
  assert.throws(() => parseDirectoryQuery({ q: "x".repeat(41) }));
});

test("OIDC state、nonce、PKCE 必须同时对上", async () => {
  const { start } = startOidc("/app", 1_000);
  assert.equal(assertOidcStart(start, start.state, 2_000).nonce, start.nonce);
  assert.throws(() => assertOidcStart(start, "other", 2_000));
  assert.throws(() => assertOidcStart(start, start.state, start.exp + 1));
  const pair = createPkcePair();
  assert.notEqual(pair.verifier, pair.challenge);
  const sealed = signPayload(start, "x".repeat(32));
  assert.equal(verifyPayload<typeof start>(sealed, "x".repeat(32))?.state, start.state);
  assert.equal(verifyPayload(sealed, "y".repeat(32)), null);

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const token = await new SignJWT({ nonce: start.nonce, name: "小文", kk_number: 7 })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(A)
    .setIssuer("https://account.example")
    .setAudience("kkchat")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  const key = await importJWK(jwk, "RS256");
  const claims = await verifyIdToken(token, { issuer: "https://account.example", audience: "kkchat", nonce: start.nonce }, key);
  assert.equal(claims.sub, A);
  await assert.rejects(() => verifyIdToken(token, { issuer: "https://account.example", audience: "kkchat", nonce: "nope" }, key));
  await assert.rejects(() => verifyIdToken(token, { issuer: "https://evil.example", audience: "kkchat", nonce: start.nonce }, key));
  // 其他产品（例如 Web 客户端 kkchat）的 ID token 不能用于 Android 客户端。
  await assert.rejects(() => verifyIdToken(token, { issuer: "https://account.example", audience: "kkchat-android", nonce: start.nonce }, key));
});

test("服务接口拒绝浏览器伪造的产品身份", () => {
  process.env.KKCHAT_SERVICE_TOKEN = "svc-token-for-tests-0123456789abcdef";
  const ok = new Request("http://kkchat.local/api/service/messages", {
    headers: { authorization: "Bearer svc-token-for-tests-0123456789abcdef", "x-kkchat-product": "academic" },
  });
  assert.equal(authorizeService(ok).product, "academic");
  const browser = new Request("http://kkchat.local/api/service/messages", { headers: { "x-kkchat-product": "academic" } });
  assert.throws(() => authorizeService(browser), /服务凭证无效/);
  const forged = new Request("http://kkchat.local/api/service/messages", {
    headers: { authorization: "Bearer svc-token-for-tests-0123456789abcdef", "x-kkchat-product": "not-a-product" },
  });
  assert.throws(() => authorizeService(forged), /产品标识/);
  const selfProduct = new Request("http://kkchat.local/api/service/messages", {
    headers: { authorization: "Bearer svc-token-for-tests-0123456789abcdef", "x-kkchat-product": "kkchat" },
  });
  assert.throws(() => authorizeService(selfProduct), /产品标识/);
});

test("旧聊天迁移跳过没有 accountSub 的人", () => {
  const items = plan({
    users: [
      { id: "local-a", accountSub: A },
      { id: "local-b", accountSub: null },
    ],
    conversations: [{ id: "c1", kind: "DIRECT", memberIds: ["local-a", "local-b"] }],
    messages: [{ id: "m1", conversationId: "c1", senderId: "local-a", body: "你好" }],
  });
  assert.equal(items.some((item) => item.action === "message"), false);
  assert.equal(items.filter((item) => item.action === "skip").length > 0, true);
});

test("最近私聊只返回对方公开资料，不表示已经是日事授权", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "在吗", idempotencyKey: "contact-1" });
  const contacts = await chat.listDirectContacts(A);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.sub, B);
  assert.equal("phone" in (contacts[0] || {}), false);
  assert.equal("email" in (contacts[0] || {}), false);
  assert.equal((await chat.listDirectContacts(C)).length, 0);
});

test("普通互聊只在未读从 0 变 1 时计划微信，已读后可以再来一次；隐藏正文生效", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  const first = await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "在吗，今晚见" });
  assert.equal(first.externalNotifies.length, 1);
  assert.equal(first.externalNotifies[0]?.eventType, "KKCHAT_MESSAGE_RECEIVED");
  assert.equal(first.externalNotifies[0]?.templateData.excerpt, "在吗，今晚见");
  const second = await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "还在吗" });
  assert.equal(second.externalNotifies.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await chat.markRead(B, conversationId);
  await db.privacySetting.create({ data: { accountSub: B, hideNotificationContent: true } });
  const third = await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "新的一轮" });
  assert.equal(third.externalNotifies.length, 1);
  assert.notEqual(third.externalNotifies[0]?.eventId, first.externalNotifies[0]?.eventId);
  assert.equal(third.externalNotifies[0]?.templateData.excerpt, "你有一条新消息");
});

test("正在查看、附件和退课成员不发微信", async () => {
  assert.equal(
    shouldNotifyWechat({ previousUnread: 0, muted: false, viewing: true, active: true, lastNotifiedAt: null, lastReadAt: null }).notify,
    false,
  );
  assert.equal(wechatExcerpt({ type: "TEXT", body: "https://cdn.example/a.pdf" }), "你有一条新消息");
  const { chat } = services();
  const group = await chat.ensureBusinessGroup({
    creatorSub: A,
    title: "高数",
    memberSubs: [B, C],
    sourceProduct: "course",
    businessType: "course-class",
    businessRefId: "course-1",
  });
  const service = { kind: "service" as const, product: "course" };
  const announced = await chat.sendMessage({
    actor: service,
    senderSub: A,
    conversationId: group.id,
    body: "今晚课前看讲义",
    metadata: { notice: "course-announcement", courseName: "高数" },
  });
  assert.equal(announced.externalNotifies.some((item) => item.recipientSub === B), true);
  assert.equal(announced.externalNotifies.find((item) => item.recipientSub === C)?.eventType, "COURSE_TEACHER_ANNOUNCEMENT");
  assert.equal(announced.externalNotifies.find((item) => item.recipientSub === C)?.templateData.courseName, "高数");
  await chat.ensureBusinessGroup({
    creatorSub: A,
    title: "高数",
    memberSubs: [B],
    sourceProduct: "course",
    businessType: "course-class",
    businessRefId: "course-1",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await chat.markRead(B, group.id);
  const again = await chat.sendMessage({
    actor: service,
    senderSub: A,
    conversationId: group.id,
    body: "只发给还在课的人",
    metadata: { notice: "course-announcement", courseName: "高数" },
  });
  assert.equal(again.externalNotifies.some((item) => item.recipientSub === C), false);
  assert.equal(again.externalNotifies.some((item) => item.recipientSub === B), true);
  await assert.rejects(() => chat.getThread(C, group.id), /不能查看这个会话/);
});

test("实时事件只发给参与者", () => {
  const bus = new MemoryRealtimeBus();
  const seen: string[] = [];
  bus.subscribe(C, () => seen.push("c"));
  bus.subscribe(B, () => seen.push("b"));
  bus.publish([{ accountSub: B, seq: 1, kind: "message", conversationId: "1", data: {} }]);
  assert.deepEqual(seen, ["b"]);
});

test("进程退出时结束所有还开着的实时连接，已关闭的不再通知", () => {
  const bus = new MemoryRealtimeBus();
  const closed: string[] = [];
  bus.onShutdown(() => closed.push("b"));
  const stopC = bus.onShutdown(() => closed.push("c"));
  bus.onShutdown(() => {
    throw new Error("连接已断");
  });
  stopC();
  bus.shutdown();
  assert.deepEqual(closed, ["b"]);
});

test.after(async () => {
  await db.$disconnect();
});
