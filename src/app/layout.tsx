import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KKChat",
  description: "统一账号、即时沟通、连接公司各产品。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hans">
      <body>{children}</body>
    </html>
  );
}
