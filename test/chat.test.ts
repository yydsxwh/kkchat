import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { ChatService } from "../src/lib/chat-service";
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
import { MemoryChatStore } from "../src/lib/store";
import { plan } from "../scripts/migrate-legacy-chat";

const A = "usr_0123456789ABCDEFGHJKMNPQRS";
const B = "usr_0123456789ABCDEFGHJKMNPQRT";
const C = "usr_0123456789ABCDEFGHJKMNPQRV";

function service() {
  return new ChatService(new MemoryChatStore(), new MemoryRealtimeBus());
}

test("directKey 与发起顺序、产品入口无关", () => {
  assert.equal(buildDirectKey(A, B), buildDirectKey(B, A));
  assert.throws(() => buildDirectKey(A, A));
});

test("同一对账号从主站和教务进入，仍是同一个私聊", async () => {
  const chat = service();
  const fromMain = await chat.ensureDirect({ senderSub: A, recipientSub: B, sourceProduct: "main" });
  const fromAcademic = await chat.ensureDirect({ senderSub: B, recipientSub: A, sourceProduct: "academic" });
  assert.equal(fromMain.id, fromAcademic.id);
  await chat.sendMessage({ senderSub: A, recipientSub: B, body: "来自主站", sourceProduct: "main", idempotencyKey: "m1" });
  await chat.sendMessage({ senderSub: A, conversationId: fromAcademic.id, body: "来自教务", sourceProduct: "academic", idempotencyKey: "a1" });
  const thread = await chat.getThread(B, fromMain.id);
  assert.equal(thread.messages.length, 2);
  assert.deepEqual(thread.messages.map((item) => item.sourceProduct), ["main", "academic"]);
});

test("不是成员不能读会话", async () => {
  const chat = service();
  const conversation = await chat.ensureDirect({ senderSub: A, recipientSub: B, sourceProduct: "kkchat" });
  await assert.rejects(() => chat.getThread(C, conversation.id), /不能查看这个会话/);
});

test("未读增加，打开后清零，对方看到已读", async () => {
  const chat = service();
  const conversation = await chat.ensureDirect({ senderSub: A, recipientSub: B, sourceProduct: "kkchat" });
  await chat.sendMessage({ senderSub: A, conversationId: conversation.id, body: "在吗", sourceProduct: "kkchat" });
  const inbox = await chat.listInbox(B);
  assert.equal(inbox[0]?.unreadCount, 1);
  assert.equal(await chat.totalUnread(B), 1);
  assert.equal((await chat.getThread(A, conversation.id)).messages[0]?.read, false);
  const later = new Date(Date.now() + 1000);
  await chat.markRead(B, conversation.id, later);
  assert.equal(await chat.totalUnread(B), 0);
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 0);
  assert.equal((await chat.getThread(A, conversation.id)).messages[0]?.read, true);
});

test("相同幂等键不会写成两条", async () => {
  const chat = service();
  const conversation = await chat.ensureDirect({ senderSub: A, recipientSub: B, sourceProduct: "kkchat" });
  const first = await chat.sendMessage({
    senderSub: A,
    conversationId: conversation.id,
    body: "只发一次",
    sourceProduct: "kkchat",
    idempotencyKey: "same",
  });
  const second = await chat.sendMessage({
    senderSub: A,
    conversationId: conversation.id,
    body: "只发一次",
    sourceProduct: "kkchat",
    idempotencyKey: "same",
  });
  assert.equal(second.duplicate, true);
  assert.equal(first.message.id, second.message.id);
  assert.equal((await chat.getThread(B, conversation.id)).messages.length, 1);
  assert.equal((await chat.listInbox(B))[0]?.unreadCount, 1);
});

test("两分钟内可撤回自己的消息，超时或别人的消息不行", async () => {
  const chat = service();
  const conversation = await chat.ensureDirect({ senderSub: A, recipientSub: B, sourceProduct: "kkchat" });
  const sentAt = new Date("2026-10-03T00:00:00Z");
  const sent = await chat.sendMessage({
    senderSub: A,
    conversationId: conversation.id,
    body: "说错了",
    sourceProduct: "kkchat",
    now: sentAt,
  });
  assert.equal(canRecall(sent.message, B, new Date(sentAt.getTime() + 1000)), false);
  await assert.rejects(() => chat.recall(B, sent.message.id, new Date(sentAt.getTime() + 1000)));
  const recalled = await chat.recall(A, sent.message.id, new Date(sentAt.getTime() + 30_000));
  assert.equal(recalled.body, null);
  await assert.rejects(() => chat.recall(A, sent.message.id, new Date(sentAt.getTime() + 40_000)));
  const late = await chat.sendMessage({
    senderSub: A,
    conversationId: conversation.id,
    body: "太晚了",
    sourceProduct: "kkchat",
    now: sentAt,
  });
  await assert.rejects(() => chat.recall(A, late.message.id, new Date(sentAt.getTime() + RECALL_AFTER)));
});

const RECALL_AFTER = 3 * 60 * 1000;

test("消息按纯文本保存，超长会被拒绝", () => {
  assert.equal(sanitizeMessageBody("  <b>你好</b>  "), "<b>你好</b>");
  assert.equal(messagePreview("x".repeat(100), false).endsWith("…"), true);
  assert.throws(() => sanitizeMessageBody(""));
  assert.throws(() => sanitizeMessageBody("x".repeat(4001)));
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
  const claims = await verifyIdToken(token, { issuer: "https://account.example", audience: "kkchat", nonce: start.nonce }, await importJWK(jwk, "RS256"));
  assert.equal(claims.sub, A);
  const key = await importJWK(jwk, "RS256");
  await assert.rejects(() =>
    verifyIdToken(token, { issuer: "https://account.example", audience: "kkchat", nonce: "nope" }, key),
  );
  await assert.rejects(() =>
    verifyIdToken(token, { issuer: "https://evil.example", audience: "kkchat", nonce: start.nonce }, key),
  );
});

test("服务接口拒绝浏览器伪造的产品身份", () => {
  process.env.KKCHAT_SERVICE_TOKEN = "svc-token-for-tests-0123456789abcdef";
  const ok = new Request("http://kkchat.local/api/service/messages", {
    headers: {
      authorization: "Bearer svc-token-for-tests-0123456789abcdef",
      "x-kkchat-product": "academic",
    },
  });
  assert.equal(authorizeService(ok).product, "academic");
  const browser = new Request("http://kkchat.local/api/service/messages", {
    headers: { "x-kkchat-product": "academic" },
  });
  assert.throws(() => authorizeService(browser), /服务凭证无效/);
  const forged = new Request("http://kkchat.local/api/service/messages", {
    headers: {
      authorization: "Bearer svc-token-for-tests-0123456789abcdef",
      "x-kkchat-product": "not-a-product",
    },
  });
  assert.throws(() => authorizeService(forged), /产品标识/);
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

test("实时事件只发给参与者", () => {
  const bus = new MemoryRealtimeBus();
  const seen: string[] = [];
  bus.subscribe(C, () => seen.push("c"));
  bus.subscribe(B, () => seen.push("b"));
  bus.publish({ kind: "message", conversationId: "1", accountSubs: [A, B], data: {} });
  assert.deepEqual(seen, ["b"]);
});
