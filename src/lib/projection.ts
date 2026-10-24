import { randomUUID } from "node:crypto";
import type { PrismaClient, UserProjection } from "@prisma/client";
import { getAccountDirectory, type DirectoryUser } from "./directory";
import { assertUserPublicId, ChatError, projectionFromClaims, type AccountClaims } from "./domain";

/** 来自账号中心的公开资料多久后重新核对一次。 */
const ACCOUNT_PROFILE_TTL_MS = 6 * 60 * 60 * 1000;

export type PublicUser = {
  accountSub: string;
  kkNumber: number | null;
  username: string | null;
  displayName: string;
  avatarUrl: string;
};

export function toPublicUser(user: Pick<UserProjection, "kkNumber" | "username" | "displayName" | "avatarUrl"> | null, accountSub: string): PublicUser {
  return {
    accountSub,
    kkNumber: user?.kkNumber ?? null,
    username: user?.username ?? null,
    displayName: user?.displayName || "用户",
    avatarUrl: user?.avatarUrl || "",
  };
}

export function directoryToPublicUser(user: DirectoryUser): PublicUser {
  return {
    accountSub: user.sub,
    kkNumber: user.kk_number,
    username: user.username,
    displayName: user.name || "用户",
    avatarUrl: user.avatar || "",
  };
}

/** 登录回调里已验签的 ID token 是最可信的来源。 */
export async function upsertProjectionFromClaims(db: PrismaClient, claims: AccountClaims, now = new Date()) {
  const draft = projectionFromClaims(claims, now);
  return db.userProjection.upsert({
    where: { accountSub: draft.accountSub },
    create: { id: randomUUID(), ...draft, profileSource: "ACCOUNT" },
    update: { ...draft, profileSource: "ACCOUNT" },
  });
}

async function saveDirectoryUser(db: PrismaClient, user: DirectoryUser, now: Date) {
  const data = {
    kkNumber: user.kk_number,
    username: user.username,
    displayName: user.name || "用户",
    avatarUrl: user.avatar || "",
    profileSource: "ACCOUNT",
    profileUpdatedAt: now,
  };
  return db.userProjection.upsert({
    where: { accountSub: user.sub },
    create: { id: randomUUID(), accountSub: user.sub, publicRole: null, ...data },
    update: data,
  });
}

/**
 * 取一个人的可信投影。对方资料只从账号中心来，不接受客户端或第三人提交的昵称、KK 号。
 *
 * requireAccount=true：必须在账号中心里真实存在（好友申请、发起私聊）。目录不可用时报错，不伪造用户。
 * requireAccount=false：业务入口兜底。目录暂时不可用时用占位投影（HINT），下次会被账号中心覆盖。
 */
export async function ensureProjection(
  db: PrismaClient,
  accountSub: string,
  options: { requireAccount: boolean; hintName?: string | null; now?: Date },
): Promise<UserProjection> {
  const sub = assertUserPublicId(accountSub);
  const now = options.now || new Date();
  const existing = await db.userProjection.findUnique({ where: { accountSub: sub } });
  if (existing && existing.profileSource === "ACCOUNT" && now.getTime() - existing.profileUpdatedAt.getTime() < ACCOUNT_PROFILE_TTL_MS) {
    return existing;
  }
  let found: DirectoryUser | null = null;
  let directoryFailed = false;
  try {
    found = await getAccountDirectory().lookup(sub);
  } catch (error) {
    directoryFailed = true;
    if (options.requireAccount && !existing) {
      throw error instanceof ChatError ? error : new ChatError(502, "账号目录暂时不可用");
    }
  }
  if (found) return saveDirectoryUser(db, found, now);
  if (!directoryFailed && options.requireAccount) {
    throw new ChatError(404, "用户不存在或已不可用");
  }
  if (existing) return existing;
  const hint = (options.hintName || "").trim().slice(0, 80);
  return db.userProjection.create({
    data: {
      id: randomUUID(),
      accountSub: sub,
      displayName: hint || "用户",
      kkNumber: null,
      username: null,
      avatarUrl: "",
      publicRole: null,
      profileSource: "HINT",
      profileUpdatedAt: now,
    },
  });
}
