"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, newClientId } from "@shared/client";
import { useI18n } from "./i18n";
import { webClient as api } from "./web-client";

export function InviteActions({ token, meName }: { token: string; meName: string }) {
  const { t } = useI18n();
  const [note, setNote] = useState(t("requestMessageDefault", { name: meName }));
  const [state, setState] = useState<"idle" | "busy" | "sent" | "incoming" | "friends">("idle");
  const [error, setError] = useState("");
  const [clientRequestId] = useState(() => newClientId());

  async function send() {
    setState("busy");
    setError("");
    try {
      const result = await api.requestViaInvite(token, { message: note, clientRequestId });
      setState(result.state === "already_friends" ? "friends" : result.state === "incoming_pending" ? "incoming" : "sent");
    } catch (caught) {
      setState("idle");
      setError(caught instanceof ApiError ? caught.message : t("networkError"));
    }
  }

  if (state === "sent") return <p className="ok">{t("requestSent")}</p>;
  if (state === "friends" || state === "incoming") {
    return (
      <div className="actions">
        <p className="ok">{t(state === "friends" ? "alreadyFriends" : "requestIncoming")}</p>
        <Link className="btn btn-primary" href="/app?tab=contacts">{t("tabContacts")}</Link>
      </div>
    );
  }
  return (
    <div className="stack">
      <label className="field">
        <span>{t("requestMessage")}</span>
        <input value={note} maxLength={120} onChange={(event) => setNote(event.target.value)} />
      </label>
      {error ? <p className="notice">{error}</p> : null}
      <button className="btn btn-primary" type="button" disabled={state === "busy"} onClick={() => void send()}>
        {t("sendRequest")}
      </button>
    </div>
  );
}
