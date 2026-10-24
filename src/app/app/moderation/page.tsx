import { redirect } from "next/navigation";
import { ModerationList } from "@/components/moderation-list";
import { currentUser } from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { isModerator } from "@/lib/social";

export const dynamic = "force-dynamic";

export default async function ModerationPage() {
  const me = await currentUser();
  if (!me) redirect("/api/auth/login?returnTo=/app/moderation");
  if (!(await isModerator(prisma, me.accountSub))) redirect("/app");
  return (
    <main className="settings">
      <ModerationList />
    </main>
  );
}
