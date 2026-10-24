import type { RealtimeBus } from "./lib/realtime";

/** 服务启动时接管退出信号，并开启会话撤销巡检与过期数据清理。只在 Node 运行时。 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ startSweeper }, { prisma }, { getRealtimeBus }] = await Promise.all([
    import("./lib/session-sweeper"),
    import("./lib/db"),
    import("./lib/realtime"),
  ]);
  const bus = getRealtimeBus();
  handleShutdown(bus);
  if (process.env.KKCHAT_DISABLE_SWEEPER === "1") return;
  startSweeper(prisma, bus);
}

/**
 * Next 收到 SIGTERM 后 server.close() 会等所有连接结束，而 SSE 不会自己结束：
 * 不主动断开，就要等 systemd 的停止超时后被 SIGKILL，这段时间里新请求全部失败。
 * 这里先结束 SSE，再给在途请求留几秒，超时仍未退出就直接退出。
 */
function handleShutdown(bus: RealtimeBus) {
  const state = globalThis as unknown as { kkchatShutdownHooked?: boolean };
  if (state.kkchatShutdownHooked) return;
  state.kkchatShutdownHooked = true;
  const onSignal = (signal: NodeJS.Signals) => {
    bus.shutdown();
    setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 8_000).unref();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
