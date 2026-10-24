import { File } from "expo-file-system";
import { Platform } from "react-native";
import type { AndroidRelease } from "@shared/types";
import KkchatNative from "../modules/kkchat-native";
import { API_BASE_URL, APP_BUILD } from "./config";

export type UpdateInfo = Extract<AndroidRelease, { status: "published" }>;

/** 官网发布状态与产品中心读同一个来源（Platform Releases，经 KKChat 公开接口）。 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (Platform.OS !== "android") return null;
  const response = await fetch(`${API_BASE_URL}/api/releases/latest`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const summary = (await response.json()) as { android: AndroidRelease };
  if (summary.android.status !== "published") return null;
  return summary.android.versionCode > APP_BUILD ? summary.android : null;
}

export class UpdateError extends Error {
  constructor(readonly code: "verify" | "permission" | "download" | "unsupported") {
    super(code);
  }
}

/**
 * 下载 → 校验（SHA-256、包名、versionCode 必须更高、签名证书与当前安装一致）→ 交给系统安装界面由用户确认。
 * 任何一项不过就删掉安装包，不静默安装，也不会降级。
 */
export async function downloadAndInstall(info: UpdateInfo, onProgress: (percent: number) => void): Promise<void> {
  if (Platform.OS !== "android" || !KkchatNative?.verifyApk || !KkchatNative.installApk) throw new UpdateError("unsupported");
  const dir = KkchatNative.updatesDirectory();
  if (!dir) throw new UpdateError("unsupported");
  const target = new File(`${dir}kkchat-${info.versionCode}.apk`);
  if (target.exists) target.delete();
  let downloaded: File;
  try {
    const task = File.createDownloadTask(info.downloadUrl, target, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (totalBytes > 0) onProgress(Math.min(100, Math.round((bytesWritten / totalBytes) * 100)));
      },
    });
    const result = await task.downloadAsync();
    if (!result) throw new Error("no file");
    downloaded = result;
  } catch {
    throw new UpdateError("download");
  }
  const verification = await KkchatNative.verifyApk(downloaded.uri, info.sha256);
  if (!verification.sha256Matches || !verification.packageMatches || !verification.signerMatches || !verification.isUpgrade) {
    downloaded.delete();
    throw new UpdateError("verify");
  }
  if (!KkchatNative.canRequestPackageInstalls()) {
    KkchatNative.openInstallPermissionSettings?.();
    throw new UpdateError("permission");
  }
  KkchatNative.installApk(downloaded.uri);
}
