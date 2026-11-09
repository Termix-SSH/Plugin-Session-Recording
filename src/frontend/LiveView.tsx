import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Eye, Radio, Square } from "lucide-react";
import {
  useSlotContributions,
  useToast,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  EmptyState,
  Facts,
  ListBadge,
  ListRow,
  ListRowAction,
  PanelList,
  pluginWsUrl,
  useConfirm,
  BackButton,
} from "@termix-ssh/plugin-sdk/ui";
import type { LiveSession, SessionRecordingApi } from "./session-recording-api";
import { formatDate } from "./format";

const PLUGIN_ID = "session-recording";
const REMOTE_DISPLAY_SLOT = "session.remoteDisplay";

/** A read only copy of a live SSH session. */
function LiveTerminal({
  session,
  onEnded,
}: {
  session: LiveSession;
  onEnded: (message: string) => void;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 12,
      theme: { background: "#09090b" },
    });
    terminal.open(screen);
    let socket: WebSocket | null = null;
    let closed = false;

    void pluginWsUrl(
      PLUGIN_ID,
      `/live?id=${encodeURIComponent(session.id)}`,
    ).then((target) => {
      if (closed || !target) return;
      socket = new WebSocket(target.url, target.protocols);
      socket.onmessage = (event) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === "ready") {
          terminal.resize(
            Number(message.cols) || 80,
            Number(message.rows) || 24,
          );
          if (typeof message.snapshot === "string") {
            terminal.write(message.snapshot);
          }
        } else if (
          message.type === "data" &&
          typeof message.data === "string"
        ) {
          terminal.write(message.data);
        } else if (message.type === "ended" || message.type === "error") {
          onEndedRef.current(String(message.message ?? ""));
        }
      };
      socket.onclose = () => {
        if (!closed) onEndedRef.current("");
      };
    });

    return () => {
      closed = true;
      socket?.close();
      terminal.dispose();
    };
  }, [session.id]);

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-[#09090b] p-2">
      <div ref={screenRef} />
    </div>
  );
}

/** A read only view of a live remote desktop session, drawn by Remote Desktop. */
function LiveDisplay({
  session,
  api,
}: {
  session: LiveSession;
  api: SessionRecordingApi;
}) {
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contributions = useSlotContributions(REMOTE_DISPLAY_SLOT);
  const Display = useMemo(
    () =>
      contributions.find(
        (contribution) =>
          contribution.kind === "component" && contribution.component,
      )?.component,
    [contributions],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .viewerToken(session)
      .then((value) => {
        if (!cancelled) setToken(value);
      })
      .catch(() => {
        if (!cancelled) setError(t("live.watchFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [api, session, t]);

  if (error || !Display) {
    return (
      <EmptyState icon={Radio} title={error ?? t("live.displayUnavailable")} />
    );
  }
  if (!token) return null;
  return (
    <div className="relative min-h-0 flex-1">
      <Display
        {...({
          token,
          protocol: session.protocol,
          isVisible: true,
        } as unknown as Record<string, unknown>)}
      />
    </div>
  );
}

export function LiveView({ api }: { api: SessionRecordingApi }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [watching, setWatching] = useState<LiveSession | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await api.live());
    } catch {
      setSessions([]);
      toast.error(t("live.loadError"));
    }
  }, [api, t, toast]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const end = async (session: LiveSession) => {
    const ok = await confirm({
      title: t("live.endConfirm"),
      description: t("live.endDescription", {
        user: session.username ?? session.userId,
        host: session.hostName,
      }),
      confirmLabel: t("live.end"),
    });
    if (!ok) return;
    try {
      await api.endLive(session, t("live.endReason"));
      toast.success(t("live.ended"));
      if (watching?.id === session.id) setWatching(null);
      void load();
    } catch {
      toast.error(t("live.endFailed"));
    }
  };

  if (watching) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12.5 shrink-0 items-center gap-2 border-b border-border pr-2">
          <div className="flex h-full shrink-0 border-r border-border">
            <BackButton
              onClick={() => setWatching(null)}
              label={t("sessionLogs.back")}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-semibold">
              {watching.hostName}
            </span>
            <span className="truncate text-[10px] text-muted-foreground">
              {t("live.watchingAs", {
                user: watching.username ?? watching.userId,
              })}
            </span>
          </div>
          <ListBadge>{t("live.readOnly")}</ListBadge>
          <button
            type="button"
            onClick={() => void end(watching)}
            className="flex h-6 items-center gap-1 px-2 text-xs text-destructive hover:bg-destructive/10"
          >
            <Square className="size-3" />
            {t("live.end")}
          </button>
        </div>
        {watching.protocol === "ssh" ? (
          <LiveTerminal
            session={watching}
            onEnded={(message) => {
              toast.info(message || t("live.sessionEnded"));
              setWatching(null);
              void load();
            }}
          />
        ) : (
          <LiveDisplay session={watching} api={api} />
        )}
      </div>
    );
  }

  return (
    <PanelList
      empty={
        <EmptyState
          icon={Radio}
          title={sessions === null ? t("live.loading") : t("live.none")}
          hint={sessions === null ? undefined : t("live.noneHint")}
        />
      }
    >
      {(sessions ?? []).map((session, index) => (
        <ListRow
          key={`${session.protocol}:${session.id}`}
          stripe={index}
          tone="muted"
          icon={<Radio />}
          title={session.hostName}
          onClick={() => setWatching(session)}
          badges={
            <>
              {session.recording && (
                <ListBadge>{t("live.recording")}</ListBadge>
              )}
              <ListBadge className="ml-auto">
                {session.protocol.toUpperCase()}
              </ListBadge>
            </>
          }
          meta={
            <Facts>
              <span>{session.username ?? session.userId}</span>
              <span>
                {formatDate(new Date(session.createdAt).toISOString())}
              </span>
              {!session.isConnected && <span>{t("live.detached")}</span>}
            </Facts>
          }
          trailing={
            <>
              <ListRowAction
                label={t("live.watch")}
                onClick={() => setWatching(session)}
              >
                <Eye />
              </ListRowAction>
              <ListRowAction
                label={t("live.end")}
                tone="destructive"
                onClick={() => void end(session)}
              >
                <Square />
              </ListRowAction>
            </>
          }
        />
      ))}
    </PanelList>
  );
}
