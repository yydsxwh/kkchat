import { NativeModule, requireOptionalNativeModule } from "expo";
import type { ApkVerification, KkchatNativeEvents, NativeWindowLayout } from "./KkchatNative.types";

declare class KkchatNativeModule extends NativeModule<KkchatNativeEvents> {
  getWindowLayout(): NativeWindowLayout | null;
  canRequestPackageInstalls(): boolean;
  updatesDirectory(): string | null;
  sha256File?(path: string): Promise<string>;
  verifyApk?(path: string, expectedSha256: string): Promise<ApkVerification>;
  installApk?(path: string): boolean;
  openInstallPermissionSettings?(): boolean;
}

/** 可选加载：在不含原生模块的环境（单元测试、网页）里返回 null，调用方按「无折叠特征」处理。 */
export default requireOptionalNativeModule<KkchatNativeModule>("KkchatNative");
