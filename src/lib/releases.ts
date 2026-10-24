import { loadConfig } from "./config";

/**
 * 发布状态的唯一来源是 Platform Releases（productKey=kkchat）。
 * 官网产品中心、下载页和 App 内检查更新都读这里，不各自写死链接。
 *
 * Android 资产的 labels：versionCode、minSdk、certSha256、commit、downloadUrl（官网可直接下载的 HTTPS 地址）。
 * iOS 资产的 labels：distribution=testflight|app_store、url（真实 TestFlight 邀请或 App Store 链接）。
 * 只有已发布（PUBLISHED）且带真实链接的版本才会显示安装按钮。
 */

export const RELEASE_PRODUCT_KEY = "kkchat";

export type PlatformAsset = {
  platform: string;
  architecture: string;
  fileName: string;
  sizeBytes: number;
  checksum: string | null;
  labels: Record<string, string>;
};

export type PlatformRelease = {
  version: string;
  channel: string;
  status: string;
  releasedAt: string | null;
  changelog: string;
  minimumUpgradeFrom: string | null;
  assets: PlatformAsset[];
};

export type AndroidRelease =
  | {
      status: "published";
      version: string;
      versionCode: number;
      downloadUrl: string;
      sizeBytes: number;
      sha256: string;
      minSdk: number | null;
      certSha256: string | null;
      commit: string | null;
      releasedAt: string | null;
      changelog: string;
      minimumUpgradeFrom: string | null;
    }
  | { status: "unavailable"; reason: string };

export type IosRelease =
  | { status: "testflight" | "published"; version: string; url: string; releasedAt: string | null; changelog: string }
  | { status: "unavailable"; reason: string };

export type ReleaseSummary = {
  product: "kkchat";
  web: { status: "published"; url: string };
  android: AndroidRelease;
  ios: IosRelease;
  checkedAt: string;
};

async function platformLatest(platform: "ANDROID" | "IOS"): Promise<PlatformRelease | null | "error"> {
  const config = loadConfig();
  if (!config.platformBaseUrl || !config.platformServiceToken) return "error";
  try {
    const response = await fetch(
      `${config.platformBaseUrl}/v1/releases/${RELEASE_PRODUCT_KEY}/latest?channel=STABLE&platform=${platform}`,
      {
        headers: { authorization: `Bearer ${config.platformServiceToken}`, "x-platform-client": "kkchat", accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) return "error";
    const payload = (await response.json()) as { release?: PlatformRelease | null };
    return payload.release ?? null;
  } catch {
    return "error";
  }
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function toAndroid(release: PlatformRelease | null | "error"): AndroidRelease {
  if (release === "error") return { status: "unavailable", reason: "release_service_unreachable" };
  if (!release || release.status !== "PUBLISHED") return { status: "unavailable", reason: "not_published" };
  const asset = release.assets.find((item) => item.platform === "ANDROID");
  const downloadUrl = httpsUrl(asset?.labels.downloadUrl);
  const versionCode = Number(asset?.labels.versionCode || "");
  const sha256 = (asset?.checksum || "").replace(/^sha256:/, "");
  if (!asset || !downloadUrl || !Number.isInteger(versionCode) || !/^[0-9a-f]{64}$/.test(sha256)) {
    return { status: "unavailable", reason: "asset_incomplete" };
  }
  const minSdk = Number(asset.labels.minSdk || "");
  return {
    status: "published",
    version: release.version,
    versionCode,
    downloadUrl,
    sizeBytes: asset.sizeBytes,
    sha256,
    minSdk: Number.isInteger(minSdk) ? minSdk : null,
    certSha256: asset.labels.certSha256 || null,
    commit: asset.labels.commit || null,
    releasedAt: release.releasedAt,
    changelog: release.changelog,
    minimumUpgradeFrom: release.minimumUpgradeFrom,
  };
}

export function toIos(release: PlatformRelease | null | "error"): IosRelease {
  if (release === "error") return { status: "unavailable", reason: "release_service_unreachable" };
  if (!release || release.status !== "PUBLISHED") return { status: "unavailable", reason: "not_published" };
  const asset = release.assets.find((item) => item.platform === "IOS");
  const url = httpsUrl(asset?.labels.url);
  const distribution = asset?.labels.distribution;
  if (!asset || !url || (distribution !== "testflight" && distribution !== "app_store")) {
    return { status: "unavailable", reason: "asset_incomplete" };
  }
  return {
    status: distribution === "app_store" ? "published" : "testflight",
    version: release.version,
    url,
    releasedAt: release.releasedAt,
    changelog: release.changelog,
  };
}

let cache: { at: number; value: ReleaseSummary } | null = null;

export async function releaseSummary(now = Date.now()): Promise<ReleaseSummary> {
  if (cache && now - cache.at < 60_000) return cache.value;
  const [android, ios] = await Promise.all([platformLatest("ANDROID"), platformLatest("IOS")]);
  const value: ReleaseSummary = {
    product: "kkchat",
    web: { status: "published", url: `${loadConfig().origin}/app` },
    android: toAndroid(android),
    ios: toIos(ios),
    checkedAt: new Date(now).toISOString(),
  };
  if (android !== "error" && ios !== "error") cache = { at: now, value };
  return value;
}
