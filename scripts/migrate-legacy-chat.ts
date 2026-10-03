/**
 * 把主站旧聊天导出迁进 KKChat。默认只演练，不写库。
 *
 * 输入 JSON：
 * {
 *   "users": [{ "id": "主站用户 id", "accountSub": "usr_..." }],
 *   "conversations": [{ "id", "kind": "DIRECT", "memberIds": ["a", "b"] }],
 *   "messages": [{ "id", "conversationId", "senderId", "body", "createdAt" }]
 * }
 *
 * 任何一边对不上 accountSub 就跳过，并写进报告。不要用邮箱或昵称猜测身份。
 *
 *   npx tsx scripts/migrate-legacy-chat.ts ./legacy-chat.json
 *   npx tsx scripts/migrate-legacy-chat.ts ./legacy-chat.json --apply
 */

import { readFileSync } from "node:fs";
import { buildDirectKey, isUserPublicId, sanitizeMessageBody } from "../src/lib/domain";

type ExportUser = { id?: string; accountSub?: string | null };
type ExportConversation = { id?: string; kind?: string; memberIds?: string[] };
type ExportMessage = { id?: string; conversationId?: string; senderId?: string; body?: string; createdAt?: string };
type LegacyExport = { users?: ExportUser[]; conversations?: ExportConversation[]; messages?: ExportMessage[] };

type PlanItem =
  | { action: "direct"; senderSub: string; recipientSub: string; legacyId: string }
  | { action: "message"; senderSub: string; recipientSub: string; body: string; idempotencyKey: string }
  | { action: "skip"; legacyId: string; reason: string };

function plan(input: LegacyExport): PlanItem[] {
  const subs = new Map<string, string>();
  for (const user of input.users || []) {
    const id = String(user.id || "");
    const sub = String(user.accountSub || "");
    if (id && isUserPublicId(sub)) subs.set(id, sub);
  }
  const items: PlanItem[] = [];
  const directByLegacy = new Map<string, { senderSub: string; recipientSub: string }>();
  for (const conversation of input.conversations || []) {
    const legacyId = String(conversation.id || "");
    if (conversation.kind && conversation.kind !== "DIRECT") {
      items.push({ action: "skip", legacyId, reason: "V1 迁移只处理私聊，群聊留在主站" });
      continue;
    }
    const members = (conversation.memberIds || []).map((id) => subs.get(id) || "");
    if (members.length !== 2 || members.some((item) => !isUserPublicId(item))) {
      items.push({ action: "skip", legacyId, reason: "成员缺少可靠的 accountSub" });
      continue;
    }
    directByLegacy.set(legacyId, { senderSub: members[0], recipientSub: members[1] });
    items.push({ action: "direct", legacyId, senderSub: members[0], recipientSub: members[1] });
  }
  for (const message of input.messages || []) {
    const legacyId = String(message.id || "");
    const pair = directByLegacy.get(String(message.conversationId || ""));
    const senderSub = subs.get(String(message.senderId || "")) || "";
    if (!pair || !isUserPublicId(senderSub)) {
      items.push({ action: "skip", legacyId, reason: "消息发送者或会话无法映射到账号中心" });
      continue;
    }
    let body = "";
    try {
      body = sanitizeMessageBody(String(message.body || ""));
    } catch {
      items.push({ action: "skip", legacyId, reason: "消息正文为空或过长" });
      continue;
    }
    items.push({
      action: "message",
      senderSub,
      recipientSub: senderSub === pair.senderSub ? pair.recipientSub : pair.senderSub,
      body,
      idempotencyKey: `legacy:${legacyId}`,
    });
  }
  return items;
}

async function apply(items: PlanItem[]) {
  const base = (process.env.KKCHAT_ORIGIN || "").replace(/\/$/, "");
  const token = process.env.KKCHAT_SERVICE_TOKEN || "";
  if (!base || !token) throw new Error("缺少 KKCHAT_ORIGIN 或 KKCHAT_SERVICE_TOKEN");
  for (const item of items) {
    if (item.action === "skip") continue;
    if (item.action === "direct") {
      buildDirectKey(item.senderSub, item.recipientSub);
      continue;
    }
    const response = await fetch(`${base}/api/service/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-kkchat-product": "main",
      },
      body: JSON.stringify({
        senderSub: item.senderSub,
        recipientSub: item.recipientSub,
        body: item.body,
        messageType: "TEXT",
        idempotencyKey: item.idempotencyKey,
        sourceProduct: "main",
      }),
    });
    if (!response.ok) throw new Error(`迁移消息失败 ${response.status}`);
  }
}

async function main() {
  const file = process.argv[2];
  const applyMode = process.argv.includes("--apply");
  if (!file) {
    console.log("用法: npx tsx scripts/migrate-legacy-chat.ts <export.json> [--apply]");
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(file, "utf8")) as LegacyExport;
  const items = plan(input);
  const skipped = items.filter((item) => item.action === "skip");
  const messages = items.filter((item) => item.action === "message");
  console.log(JSON.stringify({
    mode: applyMode ? "apply" : "dry-run",
    directs: items.filter((item) => item.action === "direct").length,
    messages: messages.length,
    skipped: skipped.length,
    skipReasons: skipped,
  }, null, 2));
  if (applyMode) await apply(items);
}

if (process.argv[1]?.includes("migrate-legacy-chat")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "迁移失败");
    process.exit(1);
  });
}

export { plan };
