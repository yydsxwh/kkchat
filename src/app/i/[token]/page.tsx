import Link from "next/link";
import { translate } from "@shared/i18n";
import { InviteActions } from "@/components/invite-actions";
import { currentUser } from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { requestLocale } from "@/lib/locale";
import { resolveInvite } from "@/lib/social";

export const dynamic = "force-dynamic";

/**
 * 二维码 / 邀请链接落地页。只展示邀请人的公开资料；
 * 不授予聊天记录读取权限，也不自动成为好友，由当前登录的人确认后再发申请。
 * 没装 App 时这里就是可用的网页；装了 App 时系统会按 App Links 直接打开 App。
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await requestLocale();
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const invite = await resolveInvite(prisma, token).catch(() => null);
  const me = await currentUser();
  const returnTo = `/i/${encodeURIComponent(token)}`;
  return (
    <main className="invite">
      <Link href="/" className="wordmark">
        <span className="mark">KK</span>
        <strong>KKChat</strong>
      </Link>
      {!invite ? (
        <section className="invite-card">
          <h1>{t("inviteInvalid")}</h1>
          <Link className="btn btn-primary" href="/app">{t("appName")}</Link>
        </section>
      ) : (
        <section className="invite-card">
          <span className="avatar-lg">{Array.from(invite.owner.displayName)[0]}</span>
          <h1>{t("inviteFrom", { name: invite.owner.displayName })}</h1>
          <p className="muted">
            {invite.owner.kkNumber ? `${t("kkNumber")} ${invite.owner.kkNumber}` : ""}
            {invite.owner.username ? ` · @${invite.owner.username}` : ""}
          </p>
          {me ? (
            me.accountSub === invite.owner.accountSub ? (
              <p className="muted">{t("myQrHint")}</p>
            ) : (
              <>
                <p className="muted">{t("inviteCurrentAccount", { name: me.displayName })}</p>
                <InviteActions token={token} meName={me.displayName} />
              </>
            )
          ) : (
            <div className="actions">
              <a className="btn btn-primary" href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>{t("inviteLoginFirst")}</a>
              <a className="btn btn-ghost" href={`kkchat://i/${encodeURIComponent(token)}`}>{t("openInApp")}</a>
            </div>
          )}
          <p className="muted small">{t("signInHint")}</p>
        </section>
      )}
    </main>
  );
}
