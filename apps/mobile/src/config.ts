import Constants from "expo-constants";
import * as Application from "expo-application";
import { Platform } from "react-native";

const extra = (Constants.expoConfig?.extra || {}) as { apiBaseUrl?: string; releaseCommit?: string };

/** 聊天服务地址。只来自构建配置，不在业务代码里写死其他域名。 */
export const API_BASE_URL = (extra.apiBaseUrl || "https://kkchat.yydsxwh.com").replace(/\/$/, "");
export const API_HOST = new URL(API_BASE_URL).host;
export const APP_CALLBACK = "kkchat://auth/callback";
export const RELEASE_COMMIT = extra.releaseCommit || "dev";
export const PLATFORM: "android" | "ios" = Platform.OS === "ios" ? "ios" : "android";
export const APP_VERSION = Application.nativeApplicationVersion || "0.0.0";
export const APP_BUILD = Number(Application.nativeBuildVersion || "0");
export const ACCOUNT_CENTER = "https://account.yydsxwh.com";
export const SUPPORT_URL = "https://www.yydsxwh.com/contact";
