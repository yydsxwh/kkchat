import { redirect } from "next/navigation";
import { ChatShell } from "@/components/chat-shell";
import { currentUser } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await currentUser();
  const { id } = await params;
  if (!me) redirect(`/api/auth/login?returnTo=/app/conversations/${encodeURIComponent(id)}`);
  return <ChatShell me={me} initialConversationId={id} />;
}
