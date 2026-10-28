import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { pruneStaleAttachments, readAttachment, sniffImage, uploadAttachment } from "../src/lib/attachments";
import { pruneEvents, readEvents } from "../src/lib/sync";
import { befriend, CN_A, db, INTL_B, resetDb, services, THIRD_C } from "./support";

process.env.KKCHAT_ATTACHMENT_DIR = mkdtempSync(path.join(tmpdir(), "kkchat-att-"));

const A = CN_A;
const B = INTL_B;
const C = THIRD_C;
const user = (sub: string) => ({ kind: "user" as const, sub });

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 32]),
  Buffer.alloc(32, 1),
]);

beforeEach(resetDb);

test("M05 同一账号的同步事件按提交顺序连续编号；并发写入也不跳号", async () => {
  const { chat, friends } = services();
  const ab = await befriend(friends, A, B);
  const cb = await befriend(friends, C, B);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      chat.sendMessage({
        actor: user(index % 2 ? A : C),
        senderSub: index % 2 ? A : C,
        conversationId: index % 2 ? ab : cb,
        body: `x${index}`,
        idempotencyKey: `k${index}`,
      }),
    ),
  );
  const page = await readEvents(db, B, 0, 500);
  const seqs = page.events.map((event) => event.seq);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, index) => index + 1));
  assert.equal(page.events.filter((event) => event.kind === "message").length, 10);
  assert.equal(page.latestSeq, seqs.at(-1));
});

test("M05 补拉：按 since 分页；先撤回再看旧消息时，事件顺序保证撤回在后；游标过旧要求重新对齐", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  const sent = await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "要撤回" });
  await chat.recall(A, sent.message.id);
  const all = await readEvents(db, B, 0, 500);
  const messageEvent = all.events.find((event) => event.kind === "message");
  const recallEvent = all.events.find((event) => event.kind === "recall");
  assert.ok(messageEvent && recallEvent && recallEvent.seq > messageEvent.seq);
  assert.equal((recallEvent!.data as { body: string | null }).body, null);
  const firstPage = await readEvents(db, B, 0, 2);
  assert.equal(firstPage.events.length, 2);
  assert.equal(firstPage.hasMore, true);
  const rest = await readEvents(db, B, firstPage.nextSeq, 500);
  assert.equal(rest.events[0].seq, firstPage.nextSeq + 1);
  const ahead = await readEvents(db, B, all.latestSeq + 10, 10);
  assert.equal(ahead.resyncRequired, true);
  await db.syncEvent.updateMany({ where: { accountSub: B }, data: { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) } });
  await pruneEvents(db);
  const stale = await readEvents(db, B, 1, 10);
  assert.equal(stale.resyncRequired, true);
  const current = await readEvents(db, B, all.latestSeq, 10);
  assert.equal(current.resyncRequired, false);
});

test("好友与申请变更也进同步流，掉线的一端恢复后能校准", async () => {
  const { friends } = services();
  const sent = await friends.sendRequest({ requesterSub: A, addresseeSub: B });
  const id = sent.state === "pending" ? sent.request.id : "";
  await friends.accept(B, id);
  await friends.remove(A, B);
  const events = (await readEvents(db, A, 0, 100)).events.map((event) => `${event.kind}:${(event.data as { action: string }).action}`);
  assert.deepEqual(events, ["request:created", "conversation:created", "request:accepted", "friend:added", "friend:removed"]);
});

test("M07 图片按文件头识别；成员可看；非成员与未发送前的其他人看不到；撤回后不可读", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  assert.equal(sniffImage(PNG)?.mimeType, "image/png");
  assert.equal(sniffImage(PNG)?.width, 64);
  await assert.rejects(
    () => uploadAttachment(db, { ownerSub: A, conversationId, fileName: "evil.png", bytes: Buffer.from("<script>"), kind: "image" }),
    /只支持/,
  );
  await assert.rejects(
    () => uploadAttachment(db, { ownerSub: C, conversationId, fileName: "x.png", bytes: PNG, kind: "image" }),
    /不能在这个会话发送附件/,
  );
  const uploaded = await uploadAttachment(db, { ownerSub: A, conversationId, fileName: "照片.png", bytes: PNG, kind: "image", clientUploadId: "u1" });
  const again = await uploadAttachment(db, { ownerSub: A, conversationId, fileName: "照片.png", bytes: PNG, kind: "image", clientUploadId: "u1" });
  assert.equal(again.id, uploaded.id);
  await assert.rejects(() => readAttachment(db, B, uploaded.id), /附件不存在/);
  const sent = await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "", type: "IMAGE", metadata: { attachmentId: uploaded.id }, idempotencyKey: "img-1" });
  assert.equal(sent.message.attachment?.mimeType, "image/png");
  assert.equal(sent.message.attachment?.width, 64);
  const retry = await chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "", type: "IMAGE", metadata: { attachmentId: uploaded.id }, idempotencyKey: "img-1" });
  assert.equal(retry.duplicate, true);
  await assert.rejects(
    () => chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "", type: "IMAGE", metadata: { attachmentId: uploaded.id }, idempotencyKey: "img-2" }),
    /已经发送过/,
  );
  const read = await readAttachment(db, B, uploaded.id);
  assert.equal(read.bytes.length, PNG.length);
  await assert.rejects(() => readAttachment(db, C, uploaded.id), /附件不存在/);
  assert.equal((await chat.listInbox(B))[0].lastMessagePreview, "[图片]");
  await chat.recall(A, sent.message.id);
  await assert.rejects(() => readAttachment(db, B, uploaded.id), /撤回/);
});

test("M07 文件按扩展名白名单；上传未发送的孤立附件会被清理", async () => {
  const { friends } = services();
  const conversationId = await befriend(friends, A, B);
  await assert.rejects(
    () => uploadAttachment(db, { ownerSub: A, conversationId, fileName: "run.exe", bytes: Buffer.from("MZ"), kind: "file" }),
    /暂不支持/,
  );
  const pdf = await uploadAttachment(db, { ownerSub: A, conversationId, fileName: "课表.pdf", bytes: Buffer.from("%PDF-1.4 test"), kind: "file" });
  assert.equal(pdf.mimeType, "application/pdf");
  const removed = await pruneStaleAttachments(db, new Date(Date.now() + 25 * 60 * 60 * 1000));
  assert.equal(removed, 1);
  assert.equal((await db.attachment.findUniqueOrThrow({ where: { id: pdf.id } })).status, "DELETED");
});

test("M03 离线队列里的消息：对方删除或拉黑后再发，服务端重新校验并拒绝", async () => {
  const { chat, friends } = services();
  const conversationId = await befriend(friends, A, B);
  await friends.block(B, A);
  await assert.rejects(
    () => chat.sendMessage({ actor: user(A), senderSub: A, conversationId, body: "离线时写的", idempotencyKey: "offline-1" }),
    /还不是好友/,
  );
  assert.equal(await db.message.count({ where: { conversationId } }), 0);
});

test.after(async () => {
  await db.$disconnect();
});
