import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BackHandler } from "react-native";

export type Tab = "chats" | "contacts" | "me";

export type Route =
  | { name: "chat"; conversationId: string }
  | { name: "profile"; sub: string }
  | { name: "addFriend" }
  | { name: "scan" }
  | { name: "myQr" }
  | { name: "invite"; token: string }
  | { name: "privacy" }
  | { name: "blocks" }
  | { name: "language" }
  | { name: "devices" }
  | { name: "about" }
  | { name: "report"; targetSub: string; displayName: string; messageId?: string; conversationId?: string };

type Nav = {
  tab: Tab;
  stack: Route[];
  top: Route | null;
  setTab(tab: Tab): void;
  push(route: Route): void;
  replace(route: Route): void;
  pop(): void;
  reset(): void;
  /** 分栏时右侧的详情：打开会话 / 资料会替换右侧，而不是一层层叠。 */
  openDetail(route: Route): void;
};

const Ctx = createContext<Nav | null>(null);

/**
 * 单根导航：所有页面挂在同一棵树下。双屏展开 / 收拢、跨屏切换时不重建页面，
 * 当前会话、滚动位置、未发送草稿、附件进度都不会丢。
 */
export function NavProvider({ children }: { children: ReactNode }) {
  const [tab, setTabState] = useState<Tab>("chats");
  const [stack, setStack] = useState<Route[]>([]);
  const stackRef = useRef<Route[]>([]);
  stackRef.current = stack;
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    setStack([]);
  }, []);
  const push = useCallback((route: Route) => setStack((prev) => [...prev, route]), []);
  const replace = useCallback((route: Route) => setStack((prev) => [...prev.slice(0, -1), route]), []);
  const pop = useCallback(() => setStack((prev) => prev.slice(0, -1)), []);
  const reset = useCallback(() => setStack([]), []);
  const openDetail = useCallback((route: Route) => setStack([route]), []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (stackRef.current.length > 0) {
        setStack((prev) => prev.slice(0, -1));
        return true;
      }
      if (tab !== "chats") {
        setTabState("chats");
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [tab]);

  const value = useMemo<Nav>(
    () => ({ tab, stack, top: stack.at(-1) ?? null, setTab, push, replace, pop, reset, openDetail }),
    [openDetail, pop, push, replace, reset, setTab, stack, tab],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav() {
  const value = useContext(Ctx);
  if (!value) throw new Error("NavProvider missing");
  return value;
}
