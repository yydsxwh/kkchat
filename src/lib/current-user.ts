import { headers } from "next/headers";
import { prisma } from "./db";
import { readSession } from "./session";

export type CurrentUser = {
  accountSub: string;
  kkNumber: number | null;
  username: string | null;
  displayName: string;
  avatarUrl: string;
  publicRole: string | null;
};

/** SSR must use the same server-side tab/device decision as API routes.
 * Never read the legacy shared cookie directly when a device exists. */
export async function currentUser(): Promise<CurrentUser | null> {
  try {
    const incoming = await headers();
    const cookie = incoming.get("cookie") || "";
    const tab = incoming.get("x-yyds-tab") || "";
    const request = new Request("https://kkchat.invalid/internal/session", {
      headers: { cookie, "x-yyds-tab": tab },
    });
    const session = await readSession(request);
    if (!session) return null;
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
