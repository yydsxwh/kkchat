"use client";

import { createClient } from "@shared/client";

function readCsrf() {
  const match = document.cookie.match(/(?:^|; )kkchat_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** 网页端：HttpOnly Cookie 会话，写操作带 CSRF 头。 */
export const webClient = createClient({
  baseUrl: "",
  async headers(mutation): Promise<Record<string, string>> {
    return mutation ? { "x-kkchat-csrf": readCsrf() } : {};
  },
});
