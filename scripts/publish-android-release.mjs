#!/usr/bin/env node
// 在生产机上把一个已上传、已校验的 Android 安装包登记到 Platform Releases（productKey=kkchat）。
// 产品中心、下载页、App 内检查更新都读这份登记。没有通过下面的校验就不登记、不发布。
//
//   PLATFORM_BASE_URL=... PLATFORM_SERVICE_TOKEN=... node scripts/publish-android-release.mjs \
//     --apk /var/www/kkchat-downloads/android/kkchat-1.0.0-1.apk \
//     --meta /var/www/kkchat-downloads/android/kkchat-1.0.0-1.json \
//     --download-url https://kkchat.yydsxwh.com/downloads/android/kkchat-1.0.0-1.apk \
//     --changelog "首个正式版"
//
// 只用 Node 自带模块；凭证只从环境变量读，不打印。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const base = (process.env.PLATFORM_BASE_URL || "").replace(/\/$/, "");
const token = process.env.PLATFORM_SERVICE_TOKEN || "";
const apkPath = arg("apk");
const meta = JSON.parse(readFileSync(arg("meta"), "utf8"));
const downloadUrl = arg("download-url");
const changelog = arg("changelog") || "";
if (!base || !token || !apkPath || !downloadUrl) {
  console.error("missing PLATFORM_BASE_URL / PLATFORM_SERVICE_TOKEN / --apk / --download-url");
  process.exit(1);
}

const bytes = readFileSync(apkPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== meta.sha256 || statSync(apkPath).size !== meta.sizeBytes) {
  console.error(`apk does not match metadata: sha ${sha256} vs ${meta.sha256}`);
  process.exit(1);
}

// 发布前用公开下载地址整包 GET 一遍并核对哈希，防止链接实际返回登录页或错误页。
const publicResponse = await fetch(downloadUrl);
const publicBytes = Buffer.from(await publicResponse.arrayBuffer());
const publicSha = createHash("sha256").update(publicBytes).digest("hex");
const publicType = publicResponse.headers.get("content-type") || "";
if (!publicResponse.ok || publicSha !== sha256) {
  console.error(`public download check failed: HTTP ${publicResponse.status} type=${publicType} sha=${publicSha}`);
  process.exit(1);
}
console.log(`public GET ok: ${publicBytes.length} bytes, ${publicType}, sha256 ${publicSha}`);

const headers = { authorization: `Bearer ${token}`, "x-platform-client": "kkchat", "content-type": "application/json" };
async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(data.error || data).slice(0, 300)}`);
  return data;
}

const existing = await fetch(`${base}/v1/releases/kkchat/${encodeURIComponent(meta.version)}?channel=STABLE`, { headers });
if (existing.ok) {
  const { release } = await existing.json();
  const asset = release.assets?.find((item) => item.platform === "ANDROID");
  if (release.status === "PUBLISHED" && asset?.checksum === `sha256:${sha256}`) {
    console.log(`release ${meta.version} already published with this apk`);
    process.exit(0);
  }
  console.error(`release ${meta.version} exists in state ${release.status}; bump the version instead of overwriting`);
  process.exit(1);
}

const created = await call("POST", "/v1/storage/uploads", {
  namespace: "app-installers",
  fileName: meta.file,
  mimeType: "application/vnd.android.package-archive",
  size: bytes.length,
  labels: { product: "kkchat", versionCode: String(meta.versionCode) },
});
const fileId = created.file.id || created.file.fileId;
const put = await fetch(created.upload.url, { method: created.upload.method || "PUT", headers: created.upload.headers || {}, body: bytes });
if (!put.ok) throw new Error(`upload PUT -> ${put.status}`);
await call("POST", `/v1/storage/files/${encodeURIComponent(fileId)}/complete`, { size: bytes.length, checksum: `sha256:${sha256}` });
console.log(`stored in Platform: ${fileId}`);

const { release } = await call("POST", "/v1/internal/releases", { productKey: "kkchat", version: meta.version, channel: "STABLE", changelog });
await call("POST", `/v1/internal/releases/${release.releaseId}/assets`, {
  fileId,
  platform: "ANDROID",
  architecture: "UNIVERSAL",
  checksum: `sha256:${sha256}`,
  labels: {
    versionCode: String(meta.versionCode),
    minSdk: String(meta.minSdk),
    certSha256: meta.certSha256,
    commit: meta.commit,
    downloadUrl,
    // 1.0.0 的元数据还没有 abis 字段；那一版按构建脚本当时的默认值打包。
    abis: meta.abis || "arm64-v8a,armeabi-v7a",
  },
});
const published = await call("POST", `/v1/internal/releases/${release.releaseId}/publish`, {});
console.log(`published kkchat ${published.release.version} (${published.release.status}) release ${release.releaseId}`);
