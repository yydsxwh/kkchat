/** 纯函数：解析邀请链接与登录回调。只认本站与固定的 kkchat:// 地址，其他链接一律忽略。 */

export function parseInviteToken(text: string, apiBaseUrl: string): string | null {
  try {
    const url = new URL(text.trim());
    if (url.protocol === "kkchat:" && url.host === "i") {
      const token = url.pathname.replace(/^\//, "");
      return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
    }
    if (url.protocol === "https:" && `${url.protocol}//${url.host}` === apiBaseUrl) {
      const match = url.pathname.match(/^\/i\/([A-Za-z0-9_-]{16,64})$/);
      return match ? match[1] : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseAuthCallback(text: string, apiBaseUrl: string): { code?: string; state?: string; error?: string } | null {
  try {
    const url = new URL(text);
    const isApp = url.protocol === "kkchat:" && url.host === "auth" && url.pathname.replace(/\/$/, "") === "/callback";
    const isWeb = url.protocol === "https:" && `${url.protocol}//${url.host}` === apiBaseUrl && url.pathname.replace(/\/$/, "") === "/native/auth/callback";
    if (!isApp && !isWeb) return null;
    return {
      code: url.searchParams.get("code") || undefined,
      state: url.searchParams.get("state") || undefined,
      error: url.searchParams.get("error") || undefined,
    };
  } catch {
    return null;
  }
}
