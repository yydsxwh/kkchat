import Link from "next/link";
import { loadConfig } from "@/lib/config";
import { currentUser } from "@/lib/current-user";

const ERRORS: Record<string, string> = {
  "login-unconfigured": "登录还没配好。需要账号中心的客户端密钥和 KKChat 会话密钥。",
  state: "登录状态对不上，请重新从 KKChat 发起登录。",
  callback: "账号中心没有完成登录。请再试一次。",
  "missing-code": "账号中心没有带回授权码。",
};

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const config = loadConfig();
  const me = await currentUser();
  const message = error ? ERRORS[error] || "登录没有完成。" : "";
  return (
    <main className="landing">
      <header>
        <Link href="/" className="wordmark">
          <span className="mark">KK</span>
          <strong>KKChat</strong>
        </Link>
        <a className="btn btn-ghost" href={config.mainSiteUrl}>
          返回网站首页
        </a>
      </header>
      <section className="landing-copy">
        <p className="muted">公司的通讯层</p>
        <h1>统一账号，即时沟通，连接各产品。</h1>
        <p className="lede">
          KKChat 用账号中心的同一个人说话。主站、教务、论坛和以后的商城，都进同一条私聊，而不是各自再做一套信箱。
        </p>
        <div className="actions">
          {me ? (
            <Link className="btn btn-primary" href="/app">
              进入会话
            </Link>
          ) : (
            <a className="btn btn-primary" href="/api/auth/login?returnTo=/app">
              使用账号中心登录
            </a>
          )}
          <a className="btn btn-ghost" href={config.mainSiteUrl}>
            返回网站首页
          </a>
        </div>
        {message ? <p className="notice">{message}</p> : null}
        <ul className="points">
          <li>KK 号就是 KKChat 的公开身份号之一。找到人、发起私聊，都用这个号。</li>
          <li>登录身份来自账号中心。KKChat 不另发一套用户号。</li>
          <li>普通聊天留在这里。短信和微信只留给站长或业务上的重要提醒。</li>
        </ul>
      </section>
      <aside className="landing-card" aria-hidden="true">
        <div className="bubble-row">
          <div className="bubble theirs">课表改到周四晚上了，我在 KKChat 里跟你说。</div>
        </div>
        <div className="bubble-row mine">
          <div className="bubble mine">收到。教务那边和主站是同一个会话。</div>
        </div>
        <p className="muted">KK 号 · 公开身份，不是密码。</p>
      </aside>
    </main>
  );
}
