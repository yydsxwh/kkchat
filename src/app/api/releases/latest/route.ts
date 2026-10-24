import { releaseSummary } from "@/lib/releases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 公开的发布状态。只含版本、大小、哈希、下载地址等公开信息。 */
export async function GET() {
  const summary = await releaseSummary();
  return Response.json(summary, {
    headers: {
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}
