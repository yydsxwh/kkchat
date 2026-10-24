"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "./i18n";

export function LogoutButton() {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <button
      className="btn btn-ghost"
      type="button"
      onClick={() => {
        const csrf = readCsrf();
        void fetch("/api/auth/logout", {
          method: "POST",
          headers: { "x-kkchat-csrf": csrf },
        }).then(() => {
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith("kkchat.")) localStorage.removeItem(key);
          }
          router.push("/");
          router.refresh();
        });
      }}
    >
      {t("signOut")}
    </button>
  );
}

function readCsrf() {
  const match = document.cookie.match(/(?:^|; )kkchat_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}
