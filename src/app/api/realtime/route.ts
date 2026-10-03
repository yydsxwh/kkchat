import { requireUser } from "@/lib/http";
import { getRealtimeBus } from "@/lib/realtime";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await requireUser(request).catch(() => null);
  if (!session) return new Response("unauthorized", { status: 401 });
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval> | null = null;
  let revokeCheck: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      unsubscribe = getRealtimeBus().subscribe(session.accountSub, (event) => {
        send(`event: ${event.kind}\ndata: ${JSON.stringify(event.data)}\n\n`);
      });
      send(`event: ready\ndata: {}\n\n`);
      ping = setInterval(() => send(`: ping\n\n`), 15_000);
      revokeCheck = setInterval(() => {
        void readSession(request).then((current) => {
          if (!current || current.id !== session.id) {
            cleanup();
            try {
              controller.close();
            } catch {
              // 连接已经结束。
            }
          }
        });
      }, 20_000);
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // 连接已经结束。
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  function cleanup() {
    unsubscribe();
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
