import { ChatError, DIRECTORY_RESULT_LIMIT, parseDirectoryQuery } from "./domain";
import { loadConfig } from "./config";

export type DirectoryUser = {
  sub: string;
  kk_number: number | null;
  username: string | null;
  name: string;
  avatar: string;
  public_role: string | null;
};

const ALLOWED = new Set(["sub", "kk_number", "username", "name", "avatar", "public_role"]);

export async function searchAccountDirectory(input: {
  kkNumber?: string | null;
  username?: string | null;
  q?: string | null;
}): Promise<DirectoryUser[]> {
  const query = parseDirectoryQuery(input);
  const config = loadConfig();
  if (!config.accountInternalToken) throw new ChatError(503, "账号目录未配置");
  const url = new URL("/api/internal/directory/users", config.accountInternalBaseUrl);
  if (query.kind === "kk") url.searchParams.set("kkNumber", String(query.kkNumber));
  if (query.kind === "username") url.searchParams.set("username", query.username);
  if (query.kind === "name") url.searchParams.set("q", query.name);
  url.searchParams.set("limit", String(DIRECTORY_RESULT_LIMIT));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.accountInternalToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) throw new ChatError(503, "账号目录拒绝了服务凭证");
  if (!response.ok) throw new ChatError(502, "账号目录暂时不可用");
  const payload = (await response.json().catch(() => ({}))) as { users?: unknown };
  if (!Array.isArray(payload.users)) return [];
  return payload.users.slice(0, DIRECTORY_RESULT_LIMIT).map(minimizeUser);
}

function minimizeUser(raw: unknown): DirectoryUser {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const key of Object.keys(row)) {
    if (!ALLOWED.has(key)) delete row[key];
  }
  const kk = row.kk_number;
  return {
    sub: typeof row.sub === "string" ? row.sub : "",
    kk_number: typeof kk === "number" ? kk : null,
    username: typeof row.username === "string" ? row.username : null,
    name: typeof row.name === "string" ? row.name : "用户",
    avatar: typeof row.avatar === "string" ? row.avatar : "",
    public_role: typeof row.public_role === "string" ? row.public_role : null,
  };
}
