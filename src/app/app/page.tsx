import { redirect } from "next/navigation";
import { ChatShell } from "@/components/chat-shell";
import { currentUser } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; tab?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/api/auth/login?returnTo=/app");
  const { c, tab } = await searchParams;
  const initialTab = tab === "contacts" || tab === "me" ? tab : "chats";
  return <ChatShell me={me} initialConversationId={c || ""} initialTab={initialTab} />;
}
