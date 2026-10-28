export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const APP_CALLBACK = "kkchat://auth/callback";
const FORWARDED = ["code", "state", "error", "error_description"] as const;

/**
 * 账号中心登记的原生回调是这个 https 地址（App Links 校验通过时系统直接交给 App）。
 * 浏览器里打开时，只把授权结果转给固定的 kkchat:// 回调，不接受任何跳转目标参数。
 * 授权码只能配合 App 内的 PKCE verifier 和登录事务密钥使用，单独拿到没有用。
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const target = new URL(APP_CALLBACK);
  for (const key of FORWARDED) {
    const value = url.searchParams.get(key);
    if (value) target.searchParams.set(key, value.slice(0, 500));
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
