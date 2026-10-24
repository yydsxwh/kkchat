/** 服务启动时开启会话撤销巡检与过期数据清理。只在 Node 运行时、且未显式关闭时启动。 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.KKCHAT_DISABLE_SWEEPER === "1") return;
  const [{ startSweeper }, { prisma }, { getRealtimeBus }] = await Promise.all([
    import("./lib/session-sweeper"),
    import("./lib/db"),
    import("./lib/realtime"),
  ]);
  startSweeper(prisma, getRealtimeBus());
}
