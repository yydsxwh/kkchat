"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { ApiError, newClientId } from "@shared/client";
import type { ReportReason, SearchHit } from "@shared/types";
import { useI18n } from "./i18n";
import { webClient as api } from "./web-client";

export type ReportTarget = { targetSub: string; name: string; messageId?: string; conversationId?: string };

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="text-btn" type="button" onClick={onClose}>{t("close")}</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function AddFriendModal(props: { meName: string; onClose: () => void; onOpenProfile: (sub: string) => void; onChanged: () => void }) {
  const { t } = useI18n();
  const [keyword, setKeyword] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Record<string, string>>({});
  const [note, setNote] = useState(t("requestMessageDefault", { name: props.meName }));

  async function search() {
    const text = keyword.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      let users = await api.search(text);
      if (users.length === 0 && /^[a-zA-Z][a-zA-Z0-9_]{3,19}$/.test(text)) users = await api.searchByName(text);
      setHits(users);
      if (users.length === 0) setError(t("noResults"));
    } catch (caught) {
      setHits([]);
      setError(caught instanceof ApiError ? caught.message : t("networkError"));
    } finally {
      setBusy(false);
    }
  }

  async function request(hit: SearchHit) {
    try {
      const result = await api.sendRequest({ addresseeSub: hit.accountSub, message: note, source: "search", clientRequestId: newClientId() });
      setSent((prev) => ({
        ...prev,
        [hit.accountSub]: result.state === "already_friends" ? t("alreadyFriends") : result.state === "incoming_pending" ? t("requestIncoming") : t("requestSent"),
      }));
      props.onChanged();
    } catch (caught) {
      setSent((prev) => ({ ...prev, [hit.accountSub]: caught instanceof ApiError ? caught.message : t("networkError") }));
    }
  }

  return (
    <Modal title={t("addFriend")} onClose={props.onClose}>
      <form
        className="search flush"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input autoFocus value={keyword} placeholder={t("searchUsersPlaceholder")} aria-label={t("searchUsersPlaceholder")} onChange={(event) => setKeyword(event.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? t("loading") : t("confirm")}</button>
      </form>
      <p className="muted small">{t("searchUsersHint")}</p>
      <label className="field">
        <span>{t("requestMessage")}</span>
        <input value={note} maxLength={120} onChange={(event) => setNote(event.target.value)} />
      </label>
      {error ? <p className="muted">{error}</p> : null}
      <div className="hits">
        {hits.map((hit) => (
          <div className="req" key={hit.accountSub}>
            <button type="button" className="req-who" onClick={() => props.onOpenProfile(hit.accountSub)}>
              <span className="avatar">{Array.from(hit.displayName)[0]}</span>
              <span>
                <b>{hit.displayName}</b>
                <small>
                  {hit.kkNumber ? `${t("kkNumber")} ${hit.kkNumber}` : ""}
                  {hit.username ? ` · @${hit.username}` : ""}
                </small>
              </span>
            </button>
            <div className="req-actions">
              {sent[hit.accountSub] ? (
                <small>{sent[hit.accountSub]}</small>
              ) : hit.relation === "friend" ? (
                <small>{t("alreadyFriends")}</small>
              ) : hit.relation === "outgoing" ? (
                <small>{t("requestSent")}</small>
              ) : hit.relation === "incoming" ? (
                <button className="btn btn-primary" type="button" onClick={() => props.onOpenProfile(hit.accountSub)}>{t("accept")}</button>
              ) : hit.relation === "blocked_by_me" ? (
                <small>{t("blockedList")}</small>
              ) : (
                <button className="btn btn-primary" type="button" onClick={() => void request(hit)}>{t("addFriend")}</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function QrModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function create() {
    try {
      setError("");
      const created = await api.createInvite();
      setInvite(created);
      setImage(await QRCode.toDataURL(created.url, { margin: 1, width: 280, errorCorrectionLevel: "M" }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("networkError"));
    }
  }

  useEffect(() => {
    // 打开时生成一次邀请。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title={t("myQr")} onClose={onClose}>
      <p className="muted small">{t("myQrHint")}</p>
      {error ? <p className="notice">{error}</p> : null}
      {image ? (
        // 二维码是本地生成的 data URL。
        // eslint-disable-next-line @next/next/no-img-element
        <img className="qr" src={image} alt={t("myQr")} width={280} height={280} />
      ) : (
        <p className="muted">{t("loading")}</p>
      )}
      {invite ? (
        <>
          <p className="sub-id">{invite.url}</p>
          <div className="actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(invite.url).then(() => setCopied(true));
              }}
            >
              {copied ? t("copied") : t("copyLink")}
            </button>
            {typeof navigator !== "undefined" && "share" in navigator ? (
              <button className="btn btn-ghost" type="button" onClick={() => void navigator.share({ url: invite.url, title: "KKChat" }).catch(() => undefined)}>
                {t("shareLink")}
              </button>
            ) : null}
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => void api.revokeInvites().then(create)}
            >
              {t("resetQr")}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

const REASONS: Array<{ value: ReportReason; key: "reasonSpam" | "reasonHarassment" | "reasonFraud" | "reasonIllegal" | "reasonOther" }> = [
  { value: "spam", key: "reasonSpam" },
  { value: "harassment", key: "reasonHarassment" },
  { value: "fraud", key: "reasonFraud" },
  { value: "illegal", key: "reasonIllegal" },
  { value: "other", key: "reasonOther" },
];

export function ReportModal({ target, onClose, onDone }: { target: ReportTarget; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState<ReportReason>("spam");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal title={`${t("reportTitle")} · ${target.name}`} onClose={onClose}>
      <fieldset className="choices">
        <legend>{t("reportReason")}</legend>
        {REASONS.map((item) => (
          <label key={item.value}>
            <input type="radio" name="reason" checked={reason === item.value} onChange={() => setReason(item.value)} /> {t(item.key)}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>{t("reportDetail")}</span>
        <textarea value={detail} maxLength={500} rows={3} onChange={(event) => setDetail(event.target.value)} />
      </label>
      {error ? <p className="notice">{error}</p> : null}
      <div className="actions">
        <button
          className="btn btn-primary"
          type="button"
          onClick={() =>
            void api
              .report({ targetSub: target.targetSub, reason, detail, messageId: target.messageId, conversationId: target.messageId ? undefined : target.conversationId })
              .then(() => {
                onDone();
                onClose();
              })
              .catch((caught) => setError(caught instanceof ApiError ? caught.message : t("networkError")))
          }
        >
          {t("confirm")}
        </button>
        <button className="btn btn-ghost" type="button" onClick={onClose}>{t("cancel")}</button>
      </div>
    </Modal>
  );
}
