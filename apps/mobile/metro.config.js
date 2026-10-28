// 让 App 直接复用仓库根目录 shared/ 里的纯 TypeScript（接口类型、客户端、合并规则、文案）。
// shared/ 不依赖 Prisma、Next.js 或任何服务端密钥。
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, "../../shared");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [sharedRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.extraNodeModules = { "@shared": sharedRoot };

module.exports = config;
