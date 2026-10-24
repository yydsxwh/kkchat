"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PrivacyView, PublicUser } from "@shared/types";
import type { CurrentUser } from "@/lib/current-user";
import { useI18n } from "./i18n";
import { LogoutButton } from "./logout-button";
import { webClient as api } from "./web-client";

const PRIVACY_KEYS: Array<{ key: keyof PrivacyView; label: "discoverByKk" | "discoverByUsername" | "discoverByName" | "allowRequests" | "hideContent" }> = [
  { key: "discoverByKkNumber", label: "discoverByKk" },
  { key: "discoverByUsername", label: "discoverByUsername" },
  { key: "discoverByName", label: "discoverByName" },
  { key: "allowFriendRequests", label: "allowRequests" },
  { key: "hideNotificationContent", label: "hideContent" },
];

export function MePanel({ me, moderator, onShowQr, onChanged }: { me: CurrentUser; moderator: boolean; onShowQr: () => void; onChanged: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const [privacy, setPrivacy] = useState<PrivacyView | null>(null);
  const [blocks, setBlocks] = useState<Array<{ peer: PublicUser; since: string }>>([]);

  useEffect(() => {
    // 进入「我的」时拉隐私设置和黑名单。
    void api.privacy().then(setPrivacy).catch(() => undefined);
    void api.blocks().then(setBlocks).catch(() => undefined);
  }, []);

  return (
    <div className="list me">
      <div className="me-card">
        <span className="avatar-lg">{me.avatarUrl ? null : Array.from(me.displayName || "?")[0]}</span>
        <b>{me.displayName}</b>
        <div className="kk">{me.kkNumber ?? "—"}</div>
        <p className="muted">{t("kkNumber")} · {me.username ? `@${me.username}` : t("noUsername")}</p>
        <button className="btn btn-primary" type="button" onClick={onShowQr}>{t("myQr")}</button>
      </div>

      <h3>{t("language")}</h3>
      <div className="seg">
        <button type="button" className={locale === "zh" ? "on" : ""} onClick={() => setLocale("zh")}>简体中文</button>
        <button type="button" className={locale === "en" ? "on" : ""} onClick={() => setLocale("en")}>English</button>
      </div>

      <h3>{t("privacy")}</h3>
      {privacy ? (
        PRIVACY_KEYS.map((item) => (
          <label className="toggle" key={item.key}>
            <span>{t(item.label)}</span>
            <input
              type="checkbox"
              checked={privacy[item.key]}
              onChange={(event) => void api.setPrivacy({ [item.key]: event.target.checked }).then(setPrivacy)}
            />
          </label>
        ))
      ) : (
        <p className="muted">{t("loading")}</p>
      )}

      <h3>{t("blockedList")}</h3>
      {blocks.length === 0 ? <p className="muted">{t("noBlocked")}</p> : null}
      {blocks.map((item) => (
        <div className="req" key={item.peer.accountSub}>
          <span className="req-who">
            <span className="avatar">{Array.from(item.peer.displayName)[0]}</span>
            <span>
              <b>{item.peer.displayName}</b>
              <small>{item.peer.kkNumber ? `${t("kkNumber")} ${item.peer.kkNumber}` : ""}</small>
            </span>
          </span>
          <div className="req-actions">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() =>
                void api.unblock(item.peer.accountSub).then(() => {
                  setBlocks((prev) => prev.filter((row) => row.peer.accountSub !== item.peer.accountSub));
                  onChanged();
                })
              }
            >
              {t("unblock")}
            </button>
          </div>
        </div>
      ))}

      <h3>{t("settings")}</h3>
      <div className="stack">
        {moderator ? <Link className="btn btn-ghost" href="/app/moderation">{t("moderation")}</Link> : null}
        <Link className="btn btn-ghost" href="/app/settings">{t("profile")}</Link>
        <a className="btn btn-ghost" href="https://account.yydsxwh.com/account/security" target="_blank" rel="noopener noreferrer">{t("deleteAccount")}</a>
        <p className="muted small">{t("deleteAccountBody")}</p>
        <p className="muted small">{t("helpBody")}</p>
        <LogoutButton />
      </div>
    </div>
  );
}
