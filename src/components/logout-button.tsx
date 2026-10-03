"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
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
          router.push("/");
          router.refresh();
        });
      }}
    >
      退出登录
    </button>
  );
}

function readCsrf() {
  const match = document.cookie.match(/(?:^|; )kkchat_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}
