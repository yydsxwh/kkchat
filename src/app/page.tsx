import Link from "next/link";
import { translate, type Locale } from "@shared/i18n";
import { loadConfig } from "@/lib/config";
import { currentUser } from "@/lib/current-user";
import { requestLocale } from "@/lib/locale";

const ERRORS: Record<string, { zh: string; en: string }> = {
  "login-unconfigured": { zh: "登录还没配好。需要账号中心的客户端密钥和 KKChat 会话密钥。", en: "Sign-in isn't configured yet." },
  state: { zh: "登录状态对不上，请重新从 KKChat 发起登录。", en: "Sign-in state didn't match. Please start again from KKChat." },
  callback: { zh: "账号中心没有完成登录。请再试一次。", en: "Account Center didn't finish signing you in. Please try again." },
  "missing-code": { zh: "账号中心没有带回授权码。", en: "Account Center didn't return an authorization code." },
  "session-revoked": { zh: "登录已在别处退出，请重新登录。", en: "You were signed out elsewhere. Please sign in again." },
};

const COPY: Record<Locale, { kicker: string; title: string; lede: string; points: string[]; enter: string; home: string; download: string }> = {
  zh: {
    kicker: "KKChat",
    title: "国内海外，同一个好友网络。",
    lede: "用账号中心的同一个账号，在网页、Android、iPhone 上和中国大陆及海外的朋友聊天。用邮箱就能注册，不需要大陆手机号或微信。",
    points: [
      "用 KK 号、账号、二维码或邀请链接添加好友，对方同意后才能私聊。",
      "网页、手机 App 共用好友和聊天记录，换设备也不会丢。",
      "可以拉黑、举报，也可以关闭被搜索到。",
    ],
    enter: "进入 KKChat",
    home: "返回网站首页",
    download: "下载 App",
  },
  en: {
    kicker: "KKChat",
    title: "One friend network, in China and worldwide.",
    lede: "Use one Account Center login to chat with friends in mainland China and abroad — on the web, Android and iPhone. Sign up with just an email address; no Chinese phone number or WeChat needed.",
    points: [
      "Add friends by KK number, account, QR code or invite link. Personal chat opens once they accept.",
      "Your friends and history are shared across web and mobile.",
      "Block, report, and control who can find you.",
    ],
    enter: "Open KKChat",
    home: "Back to website",
    download: "Get the app",
  },
};

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const config = loadConfig();
  const locale = await requestLocale();
  const copy = COPY[locale];
  const me = await currentUser();
  const message = error ? ERRORS[error]?.[locale] || translate(locale, "signInFailed") : "";
  return (
    <main className="landing">
      <header>
        <Link href="/" className="wordmark">
          <span className="mark">KK</span>
          <strong>KKChat</strong>
        </Link>
        <a className="btn btn-ghost" href={config.mainSiteUrl}>{copy.home}</a>
      </header>
      <section className="landing-copy">
        <p className="muted">{copy.kicker}</p>
        <h1>{copy.title}</h1>
        <p className="lede">{copy.lede}</p>
        <div className="actions">
          {me ? (
            <Link className="btn btn-primary" href="/app">{copy.enter}</Link>
          ) : (
            <a className="btn btn-primary" href="/api/auth/login?returnTo=/app">{translate(locale, "signIn")}</a>
          )}
          <a className="btn btn-ghost" href={`${config.mainSiteUrl}/products/kkchat`}>{copy.download}</a>
        </div>
        {message ? <p className="notice">{message}</p> : null}
        <ul className="points">
          {copy.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>
      <aside className="landing-card" aria-hidden="true">
        <div className="bubble-row">
          <div className="bubble theirs">Hola! ¿Ya llegaste a Shanghái? 🌏</div>
        </div>
        <div className="bubble-row mine">
          <div className="bubble mine">到了！我们在 KKChat 上聊。</div>
        </div>
        <p className="muted">KK · {translate(locale, "tagline")}</p>
      </aside>
    </main>
  );
}
