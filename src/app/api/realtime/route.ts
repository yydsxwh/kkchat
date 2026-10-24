import { actorStillValid, requireActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getRealtimeBus } from "@/lib/realtime";
import { latestSeq } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE。网页用 HttpOnly Cookie，App 用 Authorization 头里的短期凭证；长期凭证不进 URL。
 * 每条事件带 id=seq。断线后客户端用 /api/sync?since=<最后 seq> 补拉，重复事件按 seq 去重。
 * 会话撤销时立刻断开（设备会话由撤销逻辑主动通知），另每 20 秒复查一次。
 */
export async function GET(request: Request) {
  const actor = await requireActor(request).catch(() => null);
  if (!actor) return new Response("unauthorized", { status: 401 });
  const bus = getRealtimeBus();
  const encoder = new TextEncoder();
  const ready = await latestSeq(prisma, actor.accountSub);
  let unsubscribe = () => {};
  let stopDisconnect = () => {};
  let ping: ReturnType<typeof setInterval> | null = null;
  let revokeCheck: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // 连接已经结束。
        }
      };
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      unsubscribe = bus.subscribe(actor.accountSub, (event) => {
        send(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify({ seq: event.seq, conversationId: event.conversationId, data: event.data })}\n\n`);
      });
      stopDisconnect = bus.onDisconnect(actor.accountSub, (sessionId) => {
        if (sessionId !== actor.sessionId) return;
        send(`event: session\ndata: {"action":"revoked"}\n\n`);
        close();
      });
      send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ latestSeq: ready })}\n\n`);
      ping = setInterval(() => send(`: ping\n\n`), 15_000);
      revokeCheck = setInterval(() => {
        void actorStillValid(request, actor)
          .then((valid) => {
            if (!valid) {
              send(`event: session\ndata: {"action":"revoked"}\n\n`);
              close();
            }
          })
          .catch(() => undefined);
      }, 20_000);
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  function cleanup() {
    unsubscribe();
    stopDisconnect();
    if (ping) clearInterval(ping);
    if (revokeCheck) clearInterval(revokeCheck);
    ping = null;
    revokeCheck = null;
  }

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
