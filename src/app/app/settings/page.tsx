import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import { currentUser } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await currentUser();
  if (!me) redirect("/api/auth/login?returnTo=/app/settings");
  return (
    <main className="settings">
      <Link href="/app" className="wordmark">
        <span className="mark">KK</span>
        <strong>KKChat</strong>
      </Link>
      <h1>我的资料</h1>
      <p className="muted">这些来自账号中心的公开投影。改昵称、头像请到账号中心，下次登录会同步过来。</p>
      <dl>
        <dt>昵称</dt>
        <dd>{me.displayName}</dd>
        <dt>KK 号</dt>
        <dd>{me.kkNumber ?? "尚未分配"}</dd>
        <dt>账号</dt>
        <dd>{me.username || "未设置"}</dd>
        <dt>头像</dt>
        <dd>{me.avatarUrl ? "已设置" : "未设置"}</dd>
      </dl>
      <details>
        <summary>账号标识</summary>
        <p className="sub-id">{me.accountSub}</p>
        <p className="muted">这是账号中心的 sub，只在这个页面给排查问题用，不当作对外名字。</p>
      </details>
      <p>
        <LogoutButton />
      </p>
    </main>
  );
}
