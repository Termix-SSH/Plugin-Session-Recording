import { useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type {
  AccessEntry,
  SessionLogRecord,
  SessionRecordingApi,
} from "./session-recording-api";
import { formatDate } from "./format";

const ACTION_KEY: Record<string, string> = {
  viewed: "details.actionViewed",
  downloaded: "details.actionDownloaded",
  verified: "details.actionVerified",
  "watched-live": "details.actionWatchedLive",
  "ended-live": "details.actionEndedLive",
  "hold-on": "details.actionHoldOn",
  "hold-off": "details.actionHoldOff",
};

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** Rule matches and, for auditors, who opened the recording. */
export function RecordingDetails({
  log,
  api,
  canAudit,
}: {
  log: SessionLogRecord;
  api: SessionRecordingApi;
  canAudit: boolean;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AccessEntry[] | null>(null);
  const flags = log.flags ?? [];

  useEffect(() => {
    if (!canAudit) return;
    let cancelled = false;
    api
      .access(log.id)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, canAudit, log.id]);

  if (!flags.length && !canAudit && !log.terminationReason) return null;

  return (
    <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border text-xs">
      {log.terminationReason && (
        <div className="border-b border-border px-3 py-2 text-muted-foreground">
          {t("details.ended", { reason: log.terminationReason })}
        </div>
      )}
      {flags.length > 0 && (
        <section className="border-b border-border">
          <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            {t("details.flags", { count: flags.length })}
          </h3>
          <ul>
            {flags.map((flag, index) => (
              <li
                key={`${flag.ruleId}-${index}`}
                className="flex gap-2 px-3 py-1"
              >
                <span className="shrink-0 font-mono text-muted-foreground">
                  {clock(flag.t)}
                </span>
                <span
                  className={
                    flag.severity === "critical"
                      ? "shrink-0 text-destructive"
                      : "shrink-0"
                  }
                >
                  {flag.name}
                </span>
                <span className="truncate font-mono text-muted-foreground">
                  {flag.text}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {canAudit && (
        <section>
          <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">
            {t("details.access")}
          </h3>
          {entries === null ? null : entries.length === 0 ? (
            <p className="px-3 pb-2 text-muted-foreground">
              {t("details.noAccess")}
            </p>
          ) : (
            <ul>
              {entries.map((entry) => (
                <li key={entry.id} className="flex gap-2 px-3 py-1">
                  <span className="shrink-0 text-muted-foreground">
                    {formatDate(entry.at)}
                  </span>
                  <span className="shrink-0">
                    {entry.username ?? entry.userId ?? t("details.someone")}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {t(ACTION_KEY[entry.action] ?? "details.actionViewed")}
                    {entry.ip ? ` | ${entry.ip}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
