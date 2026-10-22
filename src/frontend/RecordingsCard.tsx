import { useCallback, useEffect, useMemo, useState } from "react";
import { Play } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { ListRow, ListRowAction, PanelList } from "@termix-ssh/plugin-sdk/ui";
import {
  createSessionRecordingApi,
  type SessionLogRecord,
} from "./session-recording-api";
import { formatBytes, formatDate, formatDuration } from "./SessionLogsPanel";

const LIMIT = 15;
const POLL_MS = 30_000;

/** Dashboard card: the latest recordings, one click to play. */
export function RecordingsCard({ isVisible, shell }: DashboardCardProps) {
  const { t } = useTranslation();
  const canView = usePermission("view");
  const client = usePluginApi();
  const api = useMemo(() => createSessionRecordingApi(client), [client]);
  const [logs, setLogs] = useState<SessionLogRecord[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setLogs(await api.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    if (!isVisible || !canView) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, canView, load]);

  if (failed || !canView) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {t("sessionLogs.loadError")}
      </p>
    );
  }
  if (!logs) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("card.loading")}</p>
    );
  }

  const open = (log: SessionLogRecord) =>
    shell.openTab(null, "session-logs", { data: { logId: log.id } });

  return (
    <PanelList
      empty={
        <p className="p-3 text-xs text-muted-foreground">
          {t("sessionLogs.noLogs")}
        </p>
      }
    >
      {logs.slice(0, LIMIT).map((log, index) => (
        <ListRow
          key={log.id}
          stripe={index}
          tone={log.endedAt ? "none" : "brand"}
          title={
            log.hostName ??
            log.hostIp ??
            t("sessionLogs.hostFallback", { id: log.hostId })
          }
          meta={[
            formatDate(log.startedAt),
            log.protocol.toUpperCase(),
            formatDuration(log.duration),
            formatBytes(log.sizeBytes),
          ].join(" | ")}
          onClick={() => open(log)}
          actions={
            <ListRowAction
              label={t("sessionLogs.viewLog")}
              tone="brand"
              onClick={() => open(log)}
            >
              <Play />
            </ListRowAction>
          }
        />
      ))}
    </PanelList>
  );
}
