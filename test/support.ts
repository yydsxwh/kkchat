process.env.DATABASE_URL = process.env.KKCHAT_TEST_DATABASE_URL || "postgresql://kkchat:kkchat@127.0.0.1:5432/kkchat_test";
process.env.KKCHAT_SESSION_SECRET = "test-session-secret-0123456789abcdef-xyz";
process.env.KKCHAT_DISABLE_SWEEPER = "1";
process.env.KKCHAT_ORIGIN = "https://kkchat.test";
process.env.ACCOUNT_ISSUER = "https://account.test";

import { PrismaClient } from "@prisma/client";
import { ChatService } from "../src/lib/chat-service";
import { setAccountDirectoryForTests, type AccountDirectory, type DirectoryUser } from "../src/lib/directory";
import { ChatError, parseDirectoryQuery } from "../src/lib/domain";
import { FriendService } from "../src/lib/friend-service";
import { MemoryRealtimeBus, type RealtimeEvent } from "../src/lib/realtime";

export const db = new PrismaClient();

/** 国内用户、海外用户各两个。账号里没有任何国家字段：好友规则不该依赖它。 */
export const CN_A = "usr_0123456789ABCDEFGHJKMNPQRS";
export const INTL_B = "usr_0123456789ABCDEFGHJKMNPQRT";
export const THIRD_C = "usr_0123456789ABCDEFGHJKMNPQRV";
export const INTL_D = "usr_0123456789ABCDEFGHJKMNPQRW";
export const NEW_E = "usr_0123456789ABCDEFGHJKMNPQRX";

export class FakeDirectory implements AccountDirectory {
  users = new Map<string, DirectoryUser>();
  failing = false;
  lookups = 0;

  add(user: Partial<DirectoryUser> & { sub: string }) {
    this.users.set(user.sub, {
      kk_number: null,
      username: null,
      name: "用户",
      avatar: "",
      public_role: null,
      ...user,
    });
  }

  async search(input: { kkNumber?: string | null; username?: string | null; q?: string | null }) {
    if (this.failing) throw new ChatError(502, "账号目录暂时不可用");
    const query = parseDirectoryQuery(input);
    return [...this.users.values()].filter((user) => {
      if (query.kind === "kk") return user.kk_number === query.kkNumber;
      if (query.kind === "username") return user.username === query.username;
      return user.name.includes(query.name);
    });
  }

  async lookup(sub: string) {
    this.lookups += 1;
    if (this.failing) throw new ChatError(502, "账号目录暂时不可用");
    return this.users.get(sub) || null;
  }
}

export const directory = new FakeDirectory();
setAccountDirectoryForTests(directory);

export function seedDirectory() {
  directory.users.clear();
  directory.failing = false;
  directory.add({ sub: CN_A, kk_number: 10001, username: "xiaowen", name: "小文" });
  directory.add({ sub: INTL_B, kk_number: 10002, username: "maria_lopez", name: "María López 🌍" });
  directory.add({ sub: THIRD_C, kk_number: 10003, username: "third_c", name: "第三人" });
  directory.add({ sub: INTL_D, kk_number: 10004, username: "kenji", name: "佐藤 健二" });
  directory.add({ sub: NEW_E, kk_number: 10005, username: "newbie", name: "小文" });
}

export async function resetDb() {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((row) => `"${row.tablename}"`).join(", ");
  if (list) await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  seedDirectory();
}

export class RecordingBus extends MemoryRealtimeBus {
  published: RealtimeEvent[] = [];
  disconnected: Array<{ accountSub: string; sessionId: string }> = [];
  publish(events: RealtimeEvent[]) {
    this.published.push(...events);
    super.publish(events);
  }
  disconnect(accountSub: string, sessionId: string) {
    this.disconnected.push({ accountSub, sessionId });
    super.disconnect(accountSub, sessionId);
  }
}

export function services() {
  const bus = new RecordingBus();
  const chat = new ChatService(db, bus);
  const friends = new FriendService(db, bus, chat);
  return { bus, chat, friends };
}

export async function befriend(friends: FriendService, a: string, b: string) {
  const sent = await friends.sendRequest({ requesterSub: a, addresseeSub: b });
  if (sent.state === "already_friends") return sent.conversationId!;
  const accepted = await friends.accept(b, sent.request.id);
  return accepted.conversationId!;
}

export async function seedProjection(sub: string, displayName: string) {
  await db.userProjection.upsert({
    where: { accountSub: sub },
    create: { id: `p-${sub}`, accountSub: sub, displayName, profileSource: "ACCOUNT" },
    update: { displayName, profileSource: "ACCOUNT" },
  });
}
