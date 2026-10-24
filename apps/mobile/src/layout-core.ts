import type { NativeFold, NativeWindowLayout } from "../modules/kkchat-native/src/KkchatNative.types";

/**
 * 纯函数：只看真实窗口特征决定布局，便于在 Node 里测试。
 * - 有「分隔」或「完全遮挡」的折叠特征（Surface Duo 跨屏时的铰链即使报告 FLAT 也算）：以铰链为边界分成两块，
 *   竖向铰链左右分栏，横向铰链上下分栏；铰链区域不放任何内容。
 * - 没有铰链但可用宽度足够（平板 / iPad / 大窗口）：列表与详情分栏。
 * - 其他情况（手机、Duo 单屏、窄分屏）：单栏。
 * 不按设备型号字符串判断。
 */

export type FoldLayout =
  | { mode: "single"; source: "window" }
  | { mode: "split-row"; first: number; gap: number; source: "hinge" | "wide"; fold: NativeFold | null }
  | { mode: "split-column"; first: number; gap: number; source: "hinge"; fold: NativeFold };

export const WIDE_SPLIT_MIN_DP = 720;
/** 分出来的任一块小于这个宽 / 高就不分栏，退回整块单区域，避免输入框落进铰链或挤成一条。 */
export const MIN_PANE_DP = 200;

export function computeLayout(native: NativeWindowLayout | null, window: { width: number; height: number }): FoldLayout {
  const density = native?.density || 1;
  const separating = native?.folds.find((fold) => fold.isSeparating || fold.occlusion === "full");
  if (native && separating) {
    if (separating.orientation === "vertical") {
      const first = separating.left / density;
      const gap = Math.max(0, (separating.right - separating.left) / density);
      if (first > MIN_PANE_DP && window.width - first - gap > MIN_PANE_DP) return { mode: "split-row", first, gap, source: "hinge", fold: separating };
    } else {
      const first = separating.top / density;
      const gap = Math.max(0, (separating.bottom - separating.top) / density);
      if (first > MIN_PANE_DP && window.height - first - gap > MIN_PANE_DP) return { mode: "split-column", first, gap, source: "hinge", fold: separating };
    }
  }
  if (window.width >= WIDE_SPLIT_MIN_DP) {
    return { mode: "split-row", first: Math.min(400, Math.round(window.width * 0.38)), gap: 1, source: "wide", fold: null };
  }
  return { mode: "single", source: "window" };
}
