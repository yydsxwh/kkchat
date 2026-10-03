import { redirect } from "next/navigation";
import { ChatShell } from "@/components/chat-shell";
import { currentUser } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/api/auth/login?returnTo=/app");
  const { c } = await searchParams;
  return <ChatShell me={me} initialConversationId={c || ""} />;
}
