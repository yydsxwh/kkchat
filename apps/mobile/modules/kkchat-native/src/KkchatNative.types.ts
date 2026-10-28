/** 原生上报的折叠特征，坐标是窗口内的物理像素。 */
export type NativeFold = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  orientation: "vertical" | "horizontal";
  isSeparating: boolean;
  occlusion: "none" | "full";
  state: "flat" | "half_opened";
};

export type NativeWindowLayout = {
  windowWidth: number;
  windowHeight: number;
  density: number;
  folds: NativeFold[];
  hasLayoutInfo: boolean;
};

export type ApkVerification = {
  sha256: string;
  sha256Matches: boolean;
  packageName: string | null;
  packageMatches: boolean;
  versionCode: number;
  installedVersionCode: number;
  isUpgrade: boolean;
  signerSha256: string[];
  signerMatches: boolean;
};

export type KkchatNativeEvents = {
  onWindowLayout(layout: NativeWindowLayout): void;
};
