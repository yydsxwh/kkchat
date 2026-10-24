import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // apps/mobile 是独立的 React Native 工程，有自己的 tsconfig 与检查命令。
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "apps/**"]),
]);

export default eslintConfig;
