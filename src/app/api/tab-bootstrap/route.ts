import { tabBootstrapScript } from "@/lib/tab-decision";

export function GET() {
  return new Response(tabBootstrapScript(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
