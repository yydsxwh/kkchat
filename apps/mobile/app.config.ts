import type { ExpoConfig } from "expo/config";
import pkg from "./package.json";

/**
 * KKChat 原生工程配置（Continuous Native Generation）。android/、ios/ 由 `npx expo prebuild` 生成，不手改。
 *
 * 版本：package.json 的 version 是 versionName / CFBundleShortVersionString；
 * KKCHAT_VERSION_CODE 是 Android versionCode 与 iOS buildNumber，每次发布必须递增。
 * KKCHAT_API_BASE_URL 只在需要指向其他环境时设置，默认正式站。
 */
const versionCode = Number(process.env.KKCHAT_VERSION_CODE || "1");
const apiBaseUrl = (process.env.KKCHAT_API_BASE_URL || "https://kkchat.yydsxwh.com").replace(/\/$/, "");
const linkHost = new URL(apiBaseUrl).host;

const config: ExpoConfig = {
  name: "KKChat",
  slug: "kkchat",
  scheme: "kkchat",
  version: pkg.version,
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "com.yydsxwh.kkchat",
    buildNumber: String(versionCode),
    supportsTablet: true,
    associatedDomains: [`applinks:${linkHost}`],
    infoPlist: {
      NSCameraUsageDescription: "扫描好友二维码时使用相机。Camera is used to scan friend QR codes.",
      NSPhotoLibraryUsageDescription: "发送图片或从相册识别二维码时访问相册。Photos are used to send images or scan a QR code from a picture.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "com.yydsxwh.kkchat",
    versionCode,
    adaptiveIcon: {
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
      backgroundColor: "#1e3a5f",
    },
    softwareKeyboardLayoutMode: "resize",
    predictiveBackGestureEnabled: false,
    permissions: ["android.permission.CAMERA", "android.permission.POST_NOTIFICATIONS"],
    blockedPermissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.READ_CONTACTS",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.SYSTEM_ALERT_WINDOW",
    ],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: linkHost, pathPrefix: "/native/auth/callback" },
          { scheme: "https", host: linkHost, pathPrefix: "/i/" },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  plugins: [
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 180,
        resizeMode: "contain",
        backgroundColor: "#f3eee4",
        dark: { image: "./assets/splash-icon.png", backgroundColor: "#161412" },
      },
    ],
    "expo-web-browser",
    "expo-secure-store",
    "expo-localization",
    [
      "expo-camera",
      {
        cameraPermission: "扫描好友二维码时使用相机。Camera is used to scan friend QR codes.",
        recordAudioAndroidPermission: false,
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "发送图片或从相册识别二维码时访问相册。Photos are used to send images or scan a QR code from a picture.",
        cameraPermission: "拍照发送时使用相机。Camera is used to take photos to send.",
        microphonePermission: false,
      },
    ],
    ["expo-notifications", { color: "#1e3a5f" }],
    "expo-sharing",
    [
      "expo-build-properties",
      {
        android: { minSdkVersion: 26 },
        ios: { deploymentTarget: "16.4" },
      },
    ],
    "./plugins/with-release-signing",
  ],
  extra: {
    apiBaseUrl,
    releaseCommit: process.env.KKCHAT_RELEASE_COMMIT || "dev",
  },
};

export default config;
