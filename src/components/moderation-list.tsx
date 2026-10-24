"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PublicUser } from "@shared/types";
import { useI18n } from "./i18n";
import { webClient as api } from "./web-client";

type Report = {
  id: string;
  reporter: PublicUser;
  target: PublicUser;
  reason: string;
  detail: string;
  messageSnapshot: string;
  status: string;
  createdAt: string;
};

export function ModerationList() {
  const { t } = useI18n();
  const [reports, setReports] = useState<Report[]>([]);
  const load = useCallback(async () => {
    const data = await api.request<{ reports: Report[] }>("/api/moderation/reports");
    setReports(data.reports);
  }, []);
  useEffect(() => {
    // 审核列表挂载后拉取。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function handle(id: string, status: "RESOLVED" | "DISMISSED") {
    await api.request(`/api/moderation/reports/${id}`, { method: "POST", json: { status } });
    await load();
  }
  return (
    <>
      <Link href="/app" className="wordmark">
        <span className="mark">KK</span>
        <strong>KKChat</strong>
      </Link>
      <h1>{t("moderation")}</h1>
      {reports.length === 0 ? <p className="muted">—</p> : null}
      {reports.map((report) => (
        <article className="report" key={report.id}>
          <p>
            <b>{report.target.displayName}</b> {report.target.kkNumber ? `(${t("kkNumber")} ${report.target.kkNumber})` : ""} ← {report.reporter.displayName}
          </p>
          <p className="muted">{report.reason} · {new Date(report.createdAt).toLocaleString()}</p>
          {report.detail ? <p>{report.detail}</p> : null}
          {report.messageSnapshot ? <pre>{report.messageSnapshot}</pre> : null}
          <div className="actions">
            <button className="btn btn-primary" type="button" onClick={() => void handle(report.id, "RESOLVED")}>{t("resolve")}</button>
            <button className="btn btn-ghost" type="button" onClick={() => void handle(report.id, "DISMISSED")}>{t("dismiss")}</button>
          </div>
        </article>
      ))}
    </>
  );
}
