import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { I18nProvider } from "@/components/i18n";
import { requestLocale } from "@/lib/locale";
import "./globals.css";

export const metadata: Metadata = {
  title: "KKChat",
  description: "使用统一账号，与国内和海外好友保持联系。One account to stay in touch with friends worldwide.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1e3a5f",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale === "zh" ? "zh-Hans" : "en"}>
      <body>
        <Script src="/api/tab-bootstrap" strategy="beforeInteractive" />
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
