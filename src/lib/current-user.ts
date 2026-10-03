import { cookies } from "next/headers";
import { prisma } from "./db";
import { SESSION_COOKIE } from "./session";

export type CurrentUser = {
  accountSub: string;
  kkNumber: number | null;
  username: string | null;
  displayName: string;
  avatarUrl: string;
  publicRole: string | null;
};

export async function currentUser(): Promise<CurrentUser | null> {
  try {
    const jar = await cookies();
    const id = jar.get(SESSION_COOKIE)?.value;
    if (!id) return null;
    const session = await prisma.browserSession.findUnique({ where: { id } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
    const user = await prisma.userProjection.findUnique({ where: { accountSub: session.accountSub } });
    if (!user) return null;
    return {
      accountSub: user.accountSub,
      kkNumber: user.kkNumber,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      publicRole: user.publicRole,
    };
  } catch {
    return null;
  }
}
