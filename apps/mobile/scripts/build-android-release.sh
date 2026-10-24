#!/usr/bin/env bash
# 构建 KKChat Android 正式签名包（APK 供官网直接安装，AAB 留给以后上架商店）。
#
# 需要的环境变量（只在构建环境里，不进仓库）：
#   KKCHAT_VERSION_CODE           本次 versionCode，必须大于线上版本
#   ANDROID_KEYSTORE_BASE64       正式 keystore（base64），或直接给 KKCHAT_UPLOAD_STORE_FILE
#   ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD / ANDROID_KEY_ALIAS
# 可选：KKCHAT_API_BASE_URL（默认 https://kkchat.yydsxwh.com）、ANDROID_HOME、
#       KKCHAT_ANDROID_ABIS（默认 arm64-v8a,armeabi-v7a：真实手机与 Surface Duo 都是 ARM，省掉 x86 让安装包小一半）
#
# 输出 release/ 下的 apk、aab 与 release.json（版本、大小、SHA-256、证书指纹、提交）。
set -euo pipefail

cd "$(dirname "$0")/.."
: "${KKCHAT_VERSION_CODE:?set KKCHAT_VERSION_CODE}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export KKCHAT_RELEASE_COMMIT="${KKCHAT_RELEASE_COMMIT:-$(git rev-parse --short HEAD)}"

cleanup() {
  if [[ -n "${TMP_KEYSTORE:-}" && -f "$TMP_KEYSTORE" ]]; then shred -u "$TMP_KEYSTORE" 2>/dev/null || rm -f "$TMP_KEYSTORE"; fi
}
trap cleanup EXIT

if [[ -z "${KKCHAT_UPLOAD_STORE_FILE:-}" ]]; then
  : "${ANDROID_KEYSTORE_BASE64:?set ANDROID_KEYSTORE_BASE64 or KKCHAT_UPLOAD_STORE_FILE}"
  TMP_KEYSTORE="$(mktemp "${TMPDIR:-/tmp}/kkchat-release.XXXXXX.keystore")"
  chmod 600 "$TMP_KEYSTORE"
  printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$TMP_KEYSTORE"
  export KKCHAT_UPLOAD_STORE_FILE="$TMP_KEYSTORE"
fi
export KKCHAT_UPLOAD_STORE_PASSWORD="${KKCHAT_UPLOAD_STORE_PASSWORD:-${ANDROID_KEYSTORE_PASSWORD:?}}"
export KKCHAT_UPLOAD_KEY_PASSWORD="${KKCHAT_UPLOAD_KEY_PASSWORD:-${ANDROID_KEY_PASSWORD:?}}"
export KKCHAT_UPLOAD_KEY_ALIAS="${KKCHAT_UPLOAD_KEY_ALIAS:-${ANDROID_KEY_ALIAS:?}}"

CI=1 npx expo prebuild --platform android --clean --no-install
ABIS="${KKCHAT_ANDROID_ABIS:-arm64-v8a,armeabi-v7a}"
(cd android && ./gradlew --no-daemon -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g" -PreactNativeArchitectures="$ABIS" assembleRelease bundleRelease)

version="$(node -p "require('./package.json').version")"
mkdir -p release
apk="release/kkchat-${version}-${KKCHAT_VERSION_CODE}.apk"
aab="release/kkchat-${version}-${KKCHAT_VERSION_CODE}.aab"
cp android/app/build/outputs/apk/release/app-release.apk "$apk"
cp android/app/build/outputs/bundle/release/app-release.aab "$aab"

build_tools="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
"$build_tools/apksigner" verify --verbose --print-certs "$apk" > release/apksigner.txt
cert_sha="$(grep -m1 'certificate SHA-256 digest' release/apksigner.txt | awk '{print $NF}' | sed 's/../&:/g;s/:$//' | tr 'a-f' 'A-F')"
sha="$(sha256sum "$apk" | awk '{print $1}')"
size="$(stat -c %s "$apk")"
min_sdk="$("$build_tools/aapt2" dump badging "$apk" | sed -n "s/.*minSdkVersion:'\([0-9]*\)'.*/\1/p" | head -1)"
node -e '
const [version, code, file, size, sha, cert, minSdk, commit, abis] = process.argv.slice(1);
console.log(JSON.stringify({ version, versionCode: Number(code), file, sizeBytes: Number(size), sha256: sha, certSha256: cert, minSdk: Number(minSdk), abis, commit, builtAt: new Date().toISOString() }, null, 2));
' "$version" "$KKCHAT_VERSION_CODE" "$(basename "$apk")" "$size" "$sha" "$cert_sha" "$min_sdk" "$KKCHAT_RELEASE_COMMIT" "$ABIS" > release/release.json
cat release/release.json
