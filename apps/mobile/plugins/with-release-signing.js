// Android 正式签名。密钥库和密码只从构建环境读取（不进仓库、不进 APK、不进 JS bundle）：
//   KKCHAT_UPLOAD_STORE_FILE      keystore 文件路径
//   KKCHAT_UPLOAD_STORE_PASSWORD  keystore 密码
//   KKCHAT_UPLOAD_KEY_ALIAS       别名
//   KKCHAT_UPLOAD_KEY_PASSWORD    私钥密码
// 缺任何一项时 release 构建直接失败，绝不退回 debug 签名冒充正式包。
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// kkchat-release-signing";

const RELEASE_SIGNING = `
        release { ${MARKER}
            def kkStore = System.getenv("KKCHAT_UPLOAD_STORE_FILE")
            if (kkStore) {
                storeFile file(kkStore)
                storePassword System.getenv("KKCHAT_UPLOAD_STORE_PASSWORD")
                keyAlias System.getenv("KKCHAT_UPLOAD_KEY_ALIAS")
                keyPassword System.getenv("KKCHAT_UPLOAD_KEY_PASSWORD")
                enableV2Signing true
                enableV3Signing true
            }
        }`;

const GUARD = `
${MARKER}-guard
gradle.taskGraph.whenReady { graph ->
    def wantsRelease = graph.allTasks.any { it.name.toLowerCase().contains("release") && (it.name.startsWith("assemble") || it.name.startsWith("bundle") || it.name.startsWith("package")) }
    if (wantsRelease) {
        ["KKCHAT_UPLOAD_STORE_FILE", "KKCHAT_UPLOAD_STORE_PASSWORD", "KKCHAT_UPLOAD_KEY_ALIAS", "KKCHAT_UPLOAD_KEY_PASSWORD"].each { name ->
            if (!System.getenv(name)) throw new GradleException("Release signing requires " + name + "; refusing to sign a release with the debug key.")
        }
    }
}
`;

function applySigning(contents) {
  if (contents.includes(MARKER)) return contents;
  let next = contents.replace(/signingConfigs\s*\{/, (match) => `${match}${RELEASE_SIGNING}`);
  const releaseBlock = /buildTypes\s*\{[\s\S]*?release\s*\{([\s\S]*?)\n\s{8}\}/;
  const found = next.match(releaseBlock);
  if (!found) throw new Error("with-release-signing: release buildType not found in app/build.gradle");
  const replacedBody = found[1].replace(/signingConfig\s+signingConfigs\.debug/, "signingConfig signingConfigs.release");
  if (replacedBody === found[1]) throw new Error("with-release-signing: release signingConfig line not found");
  next = next.replace(found[1], replacedBody);
  return `${next}\n${GUARD}`;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== "groovy") throw new Error("with-release-signing: expected Groovy build.gradle");
    mod.modResults.contents = applySigning(mod.modResults.contents);
    return mod;
  });
};

module.exports.applySigning = applySigning;
