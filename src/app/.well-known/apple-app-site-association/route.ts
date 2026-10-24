export const dynamic = "force-dynamic";

/**
 * iOS Universal Links。需要 Apple Team ID，形如 KKCHAT_IOS_APP_IDS=TEAMID.com.yydsxwh.kkchat。
 * 没有 Team ID 时返回 404，不发布一个对不上的关联文件。
 */
export function GET() {
  const appIds = (process.env.KKCHAT_IOS_APP_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(item));
  if (appIds.length === 0) return new Response("not configured", { status: 404 });
  return Response.json(
    {
      applinks: {
        details: [{ appIDs: appIds, components: [{ "/": "/native/auth/callback*" }, { "/": "/i/*" }] }],
      },
      webcredentials: { apps: appIds },
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
