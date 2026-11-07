import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  useTranslation,
  useToast,
  usePluginApi,
  usePermission,
  useSettings,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  PanelSearch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  copyToClipboard,
  useConfirm,
  EmptyState,
  Facts,
  ListBadge,
  ListRow,
  ListRowAction,
  PanelList,
  TabStrip,
  ToolbarBand,
  LoadingState,
  BackButton,
} from "@termix-ssh/plugin-sdk/ui";
import {
  Check,
  Copy,
  Download,
  Eye,
  FileText,
  Lock,
  LockOpen,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { LiveView } from "./LiveView";
import { RulesView } from "./RulesView";
import { RecordingDetails } from "./RecordingDetails";
import { SessionRecordingPlayer } from "./SessionRecordingPlayer";
import {
  SessionLogSettings,
  readSessionLogSettings,
  rowActionProps,
} from "./SessionLogSettings";
import {
  asciicastToPlainText,
  asciicastToTimestampedText,
  parseAsciicast,
  RecordingTimeError,
} from "./asciicast";
import { formatBytes, formatDate, formatDuration } from "./format";
import {
  createSessionRecordingApi,
  type SessionLogRecord,
} from "./session-recording-api";

function useAdaptivePolling(
  fn: () => Promise<boolean | void>,
  options: { minIntervalMs: number; maxIntervalMs: number },
  enabled: boolean,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let interval = options.minIntervalMs;
    let stable = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (cancelled) return;
      try {
        const changed = await fnRef.current();
        if (changed) {
          interval = options.minIntervalMs;
          stable = 0;
        } else {
          stable++;
          if (stable >= 3) {
            interval = Math.min(interval * 1.5, options.maxIntervalMs);
          }
        }
      } catch {
        // keep polling
      }
      if (!cancelled) timer = setTimeout(tick, interval);
    };

    timer = setTimeout(tick, interval);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, options.minIntervalMs, options.maxIntervalMs]);
}

export { formatBytes, formatDate, formatDuration } from "./format";

function buildFilename(log: SessionLogRecord): string {
  const host = (log.hostName ?? log.hostIp ?? "session")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 40);
  const d = new Date(log.startedAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const extension =
    log.format === "guacamole"
      ? "guac"
      : log.format === "asciicast"
        ? "cast"
        : "log";
  return `${host}_${y}-${m}-${day}_${h}-${min}-${s}.${extension}`;
}

function buildTextFilename(log: SessionLogRecord): string {
  return buildFilename(log).replace(/\.(cast|guac|log)$/, ".txt");
}

async function extractPlainText(
  log: SessionLogRecord,
  blob: Blob,
  includeTimestamps = false,
): Promise<string | null> {
  if (log.format === "guacamole") return null;
  const source = await blob.text();
  if (log.format === "text") return source;
  const recording = parseAsciicast(source, includeTimestamps);
  return includeTimestamps
    ? asciicastToTimestampedText(recording, log.startedAt)
    : asciicastToPlainText(recording);
}

function LogMeta({
  items,
  className,
}: {
  items: (string | null | undefined)[];
  className?: string;
}) {
  return (
    <span
      className={`flex min-w-0 items-center gap-x-2.5 overflow-hidden whitespace-nowrap text-[10px] ${className ?? ""}`}
    >
      {items.filter(Boolean).map((item, i) => (
        <span key={i} className="truncate last:shrink-0">
          {item}
        </span>
      ))}
    </span>
  );
}

const ACTION_BUTTON =
  "size-6 flex items-center justify-center text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors";

function ActionButton({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={
            destructive
              ? "size-6 flex items-center justify-center text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
              : ACTION_BUTTON
          }
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function LogRow({
  log,
  stripe,
  alwaysShowActions,
  onView,
  onDownload,
  onDownloadText,
  onDelete,
}: {
  log: SessionLogRecord;
  stripe: number;
  alwaysShowActions: boolean;
  onView: () => void;
  onDownload: () => void;
  onDownloadText: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const hostLabel =
    log.hostName ??
    log.hostIp ??
    t("sessionLogs.hostFallback", { id: log.hostId });

  return (
    <ListRow
      stripe={stripe}
      tone="muted"
      icon={<ScrollText />}
      title={hostLabel}
      onClick={onView}
      badges={
        <>
          {log.hold && <ListBadge>{t("sessionLogs.onHold")}</ListBadge>}
          {(log.flags?.length ?? 0) > 0 && (
            <ListBadge>
              {t("sessionLogs.flagCount", { count: log.flags?.length ?? 0 })}
            </ListBadge>
          )}
          <ListBadge className="ml-auto">
            {(log.protocol ?? "ssh").toUpperCase()}
          </ListBadge>
        </>
      }
      meta={
        <Facts>
          <span>{formatDate(log.startedAt)}</span>
          {log.username ? <span>{log.username}</span> : null}
          <span>{formatDuration(log.duration)}</span>
          <span>{formatBytes(log.sizeBytes)}</span>
        </Facts>
      }
      {...rowActionProps(
        alwaysShowActions,
        <>
          <ListRowAction label={t("sessionLogs.viewLog")} onClick={onView}>
            <Eye />
          </ListRowAction>
          {log.format === "asciicast" && (
            <ListRowAction
              label={t("sessionLogs.downloadAsText")}
              onClick={onDownloadText}
            >
              <FileText />
            </ListRowAction>
          )}
          <ListRowAction
            label={t("sessionLogs.downloadLog")}
            onClick={onDownload}
          >
            <Download />
          </ListRowAction>
          {onDelete && (
            <ListRowAction
              label={t("sessionLogs.deleteLog")}
              tone="destructive"
              onClick={onDelete}
            >
              <Trash2 />
            </ListRowAction>
          )}
        </>,
      )}
    />
  );
}

export function SessionLogsPanel({
  initialLogId,
}: {
  /** A recording to open as soon as the list has it, from the dashboard. */
  initialLogId?: number;
} = {}) {
  const { t } = useTranslation();
  const toast = useToast();
  const pluginApi = usePluginApi();
  const api = useMemo(() => createSessionRecordingApi(pluginApi), [pluginApi]);
  const canView = usePermission("view");
  const canDelete = usePermission("admin.plugins.manage");
  const canAudit = usePermission("audit");
  const canRules = usePermission("rules");
  const [view, setView] = useState<"mine" | "all" | "live" | "rules">("mine");
  const scope = view === "all" ? "all" : "mine";
  const listing = view === "mine" || view === "all";
  const [logs, setLogs] = useState<SessionLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [viewLog, setViewLog] = useState<SessionLogRecord | null>(null);
  const [viewContent, setViewContent] = useState<string>("");
  const [viewBlob, setViewBlob] = useState<Blob | null>(null);
  const [viewText, setViewText] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const confirm = useConfirm();
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = useSettings("user");
  const { alwaysShowActions } = readSessionLogSettings(settings.values);
  const logsRef = useRef(logs);
  logsRef.current = logs;

  const load = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true);
      try {
        const fresh = await api.list(scope);
        const changed =
          logsRef.current.length !== fresh.length ||
          logsRef.current.some((log, i) => log.id !== fresh[i]?.id);
        if (changed) {
          logsRef.current = fresh;
          setLogs(fresh);
        }
        return changed;
      } catch (error) {
        if (initial) {
          toast.error(t("sessionLogs.loadError"));
          return false;
        }
        throw error;
      } finally {
        if (initial) setLoading(false);
      }
    },
    [api, scope, t, toast],
  );

  useEffect(() => {
    if (!canView || !listing) return;
    logsRef.current = [];
    setLogs([]);
    void load(true);
  }, [canView, listing, load]);

  useAdaptivePolling(
    () => load(false),
    {
      minIntervalMs: 5_000,
      maxIntervalMs: 30_000,
    },
    canView && listing,
  );

  const openedInitialRef = useRef<number | null>(null);
  useEffect(() => {
    if (!initialLogId || openedInitialRef.current === initialLogId) return;
    const log = logs.find((entry) => entry.id === initialLogId);
    if (!log) return;
    openedInitialRef.current = initialLogId;
    void handleView(log);
    // The ref keeps this to one open per id.
  }, [initialLogId, logs]);

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? logs.filter((l) =>
        `${l.hostName ?? ""} ${l.hostIp ?? ""} ${l.username ?? ""} ${l.protocol}`
          .toLowerCase()
          .includes(q),
      )
    : logs;

  const handleView = async (log: SessionLogRecord) => {
    setViewLog(log);
    setViewContent("");
    setViewBlob(null);
    setViewText(null);
    setViewLoading(true);
    try {
      if (log.format === "text") {
        const text = await api.getContent(log.id);
        setViewContent(text);
        setViewText(text);
      } else {
        const blob = await api.getBlob(log.id, "view");
        setViewBlob(blob);
        setViewText(await extractPlainText(log, blob));
      }
    } catch {
      toast.error(t("sessionLogs.loadError"));
    } finally {
      setViewLoading(false);
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownload = async (log: SessionLogRecord) => {
    try {
      downloadBlob(await api.getBlob(log.id, "download"), buildFilename(log));
    } catch {
      toast.error(t("sessionLogs.loadError"));
    }
  };

  const handleDownloadText = async (log: SessionLogRecord) => {
    try {
      const current = await api.get(log.id);
      const text = await extractPlainText(
        current,
        await api.getBlob(log.id, "download"),
        current.includeOutputTimestamps === true,
      );
      if (text == null) {
        toast.error(t("sessionLogs.loadError"));
        return;
      }
      downloadBlob(
        new Blob([text], { type: "text/plain" }),
        buildTextFilename(log),
      );
    } catch (error) {
      toast.error(
        t(
          error instanceof RecordingTimeError
            ? "sessionLogs.missingTimestamps"
            : "sessionLogs.loadError",
        ),
      );
    }
  };

  const handleDelete = async (log: SessionLogRecord) => {
    const ok = await confirm({
      title: t("sessionLogs.confirmDelete"),
      description: `${
        log.hostName ??
        log.hostIp ??
        t("sessionLogs.sessionFallback", { id: log.id })
      }, ${formatDate(log.startedAt)}`,
      confirmLabel: t("sessionLogs.deleteLog"),
    });
    if (!ok) return;
    try {
      await api.delete(log.id);
      setLogs((prev) => prev.filter((l) => l.id !== log.id));
    } catch {
      toast.error(t("sessionLogs.deleteError"));
    }
  };

  const handleVerify = async (log: SessionLogRecord) => {
    try {
      const status = await api.verify(log.id);
      if (status === "ok") toast.success(t("sessionLogs.verifyOk"));
      else if (status === "changed")
        toast.error(t("sessionLogs.verifyChanged"));
      else if (status === "missing")
        toast.error(t("sessionLogs.verifyMissing"));
      else toast.info(t("sessionLogs.verifyUnknown"));
    } catch {
      toast.error(t("sessionLogs.verifyFailed"));
    }
  };

  const handleHold = async (log: SessionLogRecord) => {
    const hold = !log.hold;
    try {
      await api.setHold(log.id, hold);
      const update = (entry: SessionLogRecord) =>
        entry.id === log.id ? { ...entry, hold } : entry;
      setLogs((prev) => prev.map(update));
      setViewLog((prev) => (prev ? update(prev) : prev));
      toast.success(t(hold ? "sessionLogs.holdOn" : "sessionLogs.holdOff"));
    } catch {
      toast.error(t("sessionLogs.holdFailed"));
    }
  };

  const handleCopy = async () => {
    if (!viewText) return;
    const ok = await copyToClipboard(viewText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error(t("common.copyFailed"));
    }
  };

  if (loading && listing) {
    return <LoadingState />;
  }

  // Inline log viewer
  if (viewLog) {
    const hostLabel =
      viewLog.hostName ??
      viewLog.hostIp ??
      t("sessionLogs.hostFallback", { id: viewLog.hostId });
    return (
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Viewer header */}
        <div className="flex h-12.5 shrink-0 items-center gap-2 border-b border-border pr-2">
          <div className="flex h-full shrink-0 border-r border-border">
            <BackButton
              onClick={() => setViewLog(null)}
              label={t("sessionLogs.back")}
            />
          </div>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-xs font-semibold truncate text-foreground">
              {hostLabel}
            </span>
            <LogMeta
              className="text-muted-foreground/50"
              items={[
                formatDate(viewLog.startedAt),
                viewLog.protocol.toUpperCase(),
                viewLog.duration != null
                  ? formatDuration(viewLog.duration)
                  : null,
                formatBytes(viewLog.sizeBytes),
              ]}
            />
          </div>
          <TooltipProvider disableHoverableContent>
            <div className="flex items-center gap-0.5 shrink-0">
              {viewText != null && (
                <ActionButton
                  label={
                    copied
                      ? t("sessionLogs.copied")
                      : t("sessionLogs.copyContent")
                  }
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="size-3 text-green-500" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </ActionButton>
              )}
              {viewLog.format === "asciicast" && (
                <ActionButton
                  label={t("sessionLogs.downloadAsText")}
                  onClick={() => handleDownloadText(viewLog)}
                >
                  <FileText className="size-3" />
                </ActionButton>
              )}
              <ActionButton
                label={t("sessionLogs.downloadLog")}
                onClick={() => handleDownload(viewLog)}
              >
                <Download className="size-3" />
              </ActionButton>
              <ActionButton
                label={t("sessionLogs.verify")}
                onClick={() => void handleVerify(viewLog)}
              >
                <ShieldCheck className="size-3" />
              </ActionButton>
              {canAudit && (
                <ActionButton
                  label={t(
                    viewLog.hold
                      ? "sessionLogs.releaseHold"
                      : "sessionLogs.putOnHold",
                  )}
                  onClick={() => void handleHold(viewLog)}
                >
                  {viewLog.hold ? (
                    <LockOpen className="size-3" />
                  ) : (
                    <Lock className="size-3" />
                  )}
                </ActionButton>
              )}
            </div>
          </TooltipProvider>
        </div>

        {/* Log content */}
        <div
          className={`flex-1 min-h-0 min-w-0 ${viewBlob ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"}`}
        >
          {viewLoading ? (
            <LoadingState />
          ) : viewBlob ? (
            <SessionRecordingPlayer log={viewLog} blob={viewBlob} />
          ) : (
            <pre className="p-3 text-[11px] font-mono whitespace-pre-wrap break-all text-foreground/80 leading-relaxed">
              {viewContent || t("sessionLogs.empty")}
            </pre>
          )}
        </div>
        <RecordingDetails log={viewLog} api={api} canAudit={canAudit} />
      </div>
    );
  }

  if (settingsOpen) {
    return (
      <SessionLogSettings
        settings={settings}
        onBack={() => setSettingsOpen(false)}
      />
    );
  }

  const tabs = [
    { id: "mine", label: t("sessionLogs.tabMine") },
    ...(canAudit
      ? [
          { id: "all", label: t("sessionLogs.tabAll") },
          { id: "live", label: t("sessionLogs.tabLive") },
        ]
      : []),
    ...(canRules ? [{ id: "rules", label: t("sessionLogs.tabRules") }] : []),
  ];
  const tabStrip =
    tabs.length > 1 ? (
      <div className="shrink-0 border-b border-border px-1">
        <TabStrip
          tabs={tabs}
          activeTab={view}
          onTabChange={(id) => setView(id as typeof view)}
        />
      </div>
    ) : null;

  if (view === "live" || view === "rules") {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        {tabStrip}
        {view === "live" ? <LiveView api={api} /> : <RulesView api={api} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {tabStrip}
      {logs.length > 0 && (
        <ToolbarBand>
          <PanelSearch
            value={filter}
            onChange={setFilter}
            placeholder={t("sessionLogs.filterByHost")}
            fill
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            title={t("sessionLogs.settingsTitle")}
            aria-label={t("sessionLogs.settingsTitle")}
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>
        </ToolbarBand>
      )}
      <PanelList
        empty={
          logs.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title={t("sessionLogs.noLogs")}
              hint={t("sessionLogs.noLogsDesc")}
            />
          ) : (
            <EmptyState title={t("sessionLogs.noResults", { query: filter })} />
          )
        }
      >
        {filtered.map((log, index) => (
          <LogRow
            key={log.id}
            log={log}
            stripe={index}
            alwaysShowActions={alwaysShowActions}
            onView={() => handleView(log)}
            onDownload={() => handleDownload(log)}
            onDownloadText={() => handleDownloadText(log)}
            onDelete={canDelete ? () => void handleDelete(log) : undefined}
          />
        ))}
      </PanelList>
    </div>
  );
}
