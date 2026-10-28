import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

/**
 * 两类存储：
 * - SecureStore：凭证（按账号分开），系统 Keychain / Keystore 保护。
 * - 文档目录下按账号分开的 JSON：草稿、离线待发队列、同步游标、会话缓存。
 * 切换账号时只读写当前账号的目录，A 的草稿和待发消息不会被 B 读到或发出。
 */

const SECURE_OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

function safeKey(sub: string) {
  return sub.replace(/[^A-Za-z0-9_]/g, "_");
}

export async function secureGet<T>(key: string): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(key, SECURE_OPTS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function secureSet(key: string, value: unknown) {
  await SecureStore.setItemAsync(key, JSON.stringify(value), SECURE_OPTS);
}

export async function secureDelete(key: string) {
  await SecureStore.deleteItemAsync(key, SECURE_OPTS);
}

export const sessionKey = (sub: string) => `kkchat.session.${safeKey(sub)}`;

function accountDir(sub: string) {
  const dir = new Directory(Paths.document, "kkchat", safeKey(sub));
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export async function readAccountJson<T>(sub: string, name: string, fallback: T): Promise<T> {
  try {
    const file = new File(accountDir(sub), `${name}.json`);
    if (!file.exists) return fallback;
    return JSON.parse(await file.text()) as T;
  } catch {
    return fallback;
  }
}

export function writeAccountJson(sub: string, name: string, value: unknown) {
  try {
    const file = new File(accountDir(sub), `${name}.json`);
    if (!file.exists) file.create({ overwrite: true });
    file.writeSync(JSON.stringify(value));
  } catch {
    // 缓存写失败不影响功能，下次从服务器重新同步。
  }
}

export function clearAccountFiles(sub: string) {
  try {
    const dir = new Directory(Paths.document, "kkchat", safeKey(sub));
    if (dir.exists) dir.delete();
  } catch {
    // 忽略。
  }
}

const PREFS_FILE = () => new File(Paths.document, "kkchat-prefs.json");

export type Prefs = { language?: "zh" | "en" | "system"; notifications?: boolean };

export async function readPrefs(): Promise<Prefs> {
  try {
    const file = PREFS_FILE();
    if (!file.exists) return {};
    return JSON.parse(await file.text()) as Prefs;
  } catch {
    return {};
  }
}

export async function writePrefs(patch: Prefs) {
  const next = { ...(await readPrefs()), ...patch };
  const file = PREFS_FILE();
  if (!file.exists) file.create({ overwrite: true });
  file.writeSync(JSON.stringify(next));
  return next;
}
