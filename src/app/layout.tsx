import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "KKChat",
  description: "统一账号、即时沟通、连接公司各产品。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hans">
      <body>
        <Script src="/api/tab-bootstrap" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}
