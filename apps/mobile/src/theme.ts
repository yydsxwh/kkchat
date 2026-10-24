import { useColorScheme } from "react-native";

export type Theme = {
  dark: boolean;
  bg: string;
  panel: string;
  card: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  mine: string;
  mineInk: string;
  theirs: string;
  danger: string;
  ok: string;
  warnBg: string;
  warnInk: string;
  hinge: string;
};

const light: Theme = {
  dark: false,
  bg: "#f3eee4",
  panel: "#fffdf9",
  card: "#ffffff",
  ink: "#1c1915",
  muted: "#6d6458",
  line: "#e3d8c8",
  accent: "#c2410c",
  mine: "#1e3a5f",
  mineInk: "#f8fafc",
  theirs: "#ffffff",
  danger: "#b42318",
  ok: "#0f766e",
  warnBg: "#fff7ed",
  warnInk: "#9a3412",
  hinge: "#000000",
};

const dark: Theme = {
  dark: true,
  bg: "#161412",
  panel: "#1e1b18",
  card: "#26221e",
  ink: "#f3eee4",
  muted: "#b3a999",
  line: "#36312a",
  accent: "#f97316",
  mine: "#2f5d8f",
  mineInk: "#f8fafc",
  theirs: "#2a2622",
  danger: "#f87171",
  ok: "#2dd4bf",
  warnBg: "#3b2414",
  warnInk: "#fdba74",
  hinge: "#000000",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
