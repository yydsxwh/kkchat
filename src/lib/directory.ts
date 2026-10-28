import { ChatError, DIRECTORY_RESULT_LIMIT, isUserPublicId, parseDirectoryQuery } from "./domain";
import { loadConfig } from "./config";

export type DirectoryUser = {
  sub: string;
  kk_number: number | null;
  username: string | null;
  name: string;
  avatar: string;
  public_role: string | null;
};

export interface AccountDirectory {
  search(input: { kkNumber?: string | null; username?: string | null; q?: string | null }): Promise<DirectoryUser[]>;
  /** 按永久 sub 精确查。查不到返回 null；目录不可用时抛错。 */
  lookup(sub: string): Promise<DirectoryUser | null>;
}

const ALLOWED = new Set(["sub", "kk_number", "username", "name", "avatar", "public_role"]);

/**
 * 账号中心内部目录。只在 KKChat 服务端调用，浏览器和 App 拿不到 ACCOUNT_INTERNAL_TOKEN。
 * 返回值只保留通讯需要的公开字段，手机号、邮箱、证件不会出现在这里。
 */
class HttpAccountDirectory implements AccountDirectory {
  async search(input: { kkNumber?: string | null; username?: string | null; q?: string | null }) {
    const query = parseDirectoryQuery(input);
    const params: Record<string, string> = { limit: String(DIRECTORY_RESULT_LIMIT) };
    if (query.kind === "kk") params.kkNumber = String(query.kkNumber);
    if (query.kind === "username") params.username = query.username;
    if (query.kind === "name") params.q = query.name;
    return this.call(params);
  }

  async lookup(sub: string) {
    if (!isUserPublicId(sub)) return null;
    const users = await this.call({ sub, limit: "1" });
    return users.find((user) => user.sub === sub) || null;
  }

  private async call(params: Record<string, string>): Promise<DirectoryUser[]> {
    const config = loadConfig();
    if (!config.accountInternalToken) throw new ChatError(503, "账号目录未配置");
    const url = new URL("/api/internal/directory/users", config.accountInternalBaseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${config.accountInternalToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new ChatError(502, "账号目录暂时不可用");
    }
    if (response.status === 401) throw new ChatError(503, "账号目录拒绝了服务凭证");
    if (!response.ok) throw new ChatError(502, "账号目录暂时不可用");
    const payload = (await response.json().catch(() => ({}))) as { users?: unknown };
    if (!Array.isArray(payload.users)) return [];
    return payload.users
      .slice(0, DIRECTORY_RESULT_LIMIT)
      .map(minimizeUser)
      .filter((user) => isUserPublicId(user.sub));
  }
}

export function minimizeUser(raw: unknown): DirectoryUser {
  const row = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  for (const key of Object.keys(row)) {
    if (!ALLOWED.has(key)) delete row[key];
  }
  const kk = row.kk_number;
  return {
    sub: typeof row.sub === "string" ? row.sub : "",
    kk_number: typeof kk === "number" ? kk : null,
    username: typeof row.username === "string" ? row.username : null,
    name: typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 80) : "用户",
    avatar: typeof row.avatar === "string" ? row.avatar : "",
    public_role: typeof row.public_role === "string" ? row.public_role : null,
  };
}

let directory: AccountDirectory = new HttpAccountDirectory();

export function getAccountDirectory(): AccountDirectory {
  return directory;
}

/** 只给测试替换目录实现。 */
export function setAccountDirectoryForTests(next: AccountDirectory) {
  directory = next;
}

export async function searchAccountDirectory(input: {
  kkNumber?: string | null;
  username?: string | null;
  q?: string | null;
}): Promise<DirectoryUser[]> {
  return directory.search(input);
}
