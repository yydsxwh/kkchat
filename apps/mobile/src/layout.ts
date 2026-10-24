import { useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import KkchatNative, { type NativeWindowLayout } from "../modules/kkchat-native";
import { computeLayout } from "./layout-core";

export { computeLayout, type FoldLayout } from "./layout-core";

/** 订阅原生 WindowManager 上报的窗口与折叠特征；展开、收拢、跨屏、旋转时都会重新计算。 */
export function useFoldLayout() {
  const window = useWindowDimensions();
  const [native, setNative] = useState<NativeWindowLayout | null>(() => KkchatNative?.getWindowLayout() ?? null);
  useEffect(() => {
    if (!KkchatNative) return;
    const subscription = KkchatNative.addListener("onWindowLayout", setNative);
    setNative(KkchatNative.getWindowLayout() ?? null);
    return () => subscription.remove();
  }, []);
  const layout = useMemo(() => computeLayout(native, window), [native, window]);
  return { layout, native, window };
}
