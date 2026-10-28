export const dynamic = "force-dynamic";

/**
 * Android App Links 校验文件。包名与正式签名证书 SHA-256 指纹来自环境变量，
 * 指纹是公开信息；未配置时返回空列表，不伪造关联。
 */
export function GET() {
  const packageName = process.env.KKCHAT_ANDROID_PACKAGE?.trim() || "com.yydsxwh.kkchat";
  const fingerprints = (process.env.KKCHAT_ANDROID_CERT_SHA256 || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(item));
  const body =
    fingerprints.length === 0
      ? []
      : [
          {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: fingerprints },
          },
        ];
  return Response.json(body, { headers: { "cache-control": "public, max-age=3600" } });
}
