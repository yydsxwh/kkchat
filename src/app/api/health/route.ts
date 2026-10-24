import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 存活：进程在。就绪：?ready=1 时再查数据库，数据库不可用返回 503。不输出任何凭证。 */
export async function GET(request: Request) {
  const ready = new URL(request.url).searchParams.get("ready") === "1";
  if (!ready) return Response.json({ ok: true, status: "alive" });
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const migrations = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`;
    return Response.json({
      ok: true,
      status: "ready",
      database: "ok",
      latestMigration: migrations[0]?.migration_name ?? null,
      release: process.env.KKCHAT_RELEASE_SHA || null,
      latencyMs: Date.now() - started,
    });
  } catch {
    return Response.json({ ok: false, status: "not_ready", database: "error" }, { status: 503 });
  }
}
