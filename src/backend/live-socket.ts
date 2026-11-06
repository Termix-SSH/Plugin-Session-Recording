import type {
  PluginContext,
  PluginWebSocketConnection,
} from "@termix-ssh/plugin-sdk/backend";
import type { SessionRecordingRepository } from "./repository.js";
import type { AccessLog } from "./access.js";
import { AUDIT_PERMISSION } from "./policy.js";
import { getLive, watchSsh } from "./live.js";

interface Socket {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: "close" | "error", listener: () => void) => void;
}

const OPEN = 1;
const MAX_BUFFERED = 4 * 1024 * 1024;

/**
 * /plugin-ws/session-recording/live?id=<session>: a read only copy of a live
 * SSH session for an auditor. The socket only ever sends; anything the
 * browser sends is ignored, so a watcher can never type.
 */
export function registerLiveSocket(
  ctx: PluginContext,
  repository: SessionRecordingRepository,
  access: AccessLog,
): void {
  const open = new Set<() => void>();
  ctx.disposables.add(() => {
    for (const close of [...open]) close();
  });

  const onConnection = async (connection: PluginWebSocketConnection) => {
    const ws = connection.socket as Socket;
    const send = (message: Record<string, unknown>) => {
      if (ws.readyState !== OPEN) return;
      if ((ws.bufferedAmount ?? 0) > MAX_BUFFERED) return;
      ws.send(JSON.stringify(message));
    };
    const userId = connection.userId;
    if (!userId || !(await ctx.rbac.hasFor(userId, AUDIT_PERMISSION))) {
      ws.close(1008, "Needs the audit permission");
      return;
    }
    const url = new URL(
      String((connection.request as { url?: string }).url ?? ""),
      "http://local",
    );
    const id = url.searchParams.get("id") ?? "";
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) {
      ws.close(1008, "Invalid session");
      return;
    }

    let stop: (() => void) | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const close = () => {
      stop?.();
      stop = null;
      if (poll) clearInterval(poll);
      poll = null;
      open.delete(close);
    };
    open.add(close);
    ws.on("close", close);
    ws.on("error", close);

    try {
      const session = await getLive(ctx, "ssh", id);
      if (!session) {
        send({ type: "ended", message: "The session is not live" });
        ws.close(1000, "Not live");
        close();
        return;
      }
      const watched = await watchSsh(ctx, id, (data) =>
        send({ type: "data", data }),
      );
      if (!watched) {
        ws.close(1011, "SSH Terminal is not running");
        close();
        return;
      }
      stop = watched.stop;
      // The provider has no end event, so check every few seconds.
      poll = setInterval(() => {
        void getLive(ctx, "ssh", id)
          .catch(() => null)
          .then((still) => {
            if (still?.isConnected !== false && still) return;
            send({ type: "ended", message: "The session ended" });
            ws.close(1000, "Ended");
            close();
          });
      }, 5000);
      (poll as { unref?: () => void }).unref?.();
      send({
        type: "ready",
        cols: (session as { cols?: number }).cols ?? 80,
        rows: (session as { rows?: number }).rows ?? 24,
        snapshot: watched.snapshot ?? "",
      });
      const recording = await repository.findBySessionId(id).catch(() => null);
      await access.record("watched-live", {
        recordingId: recording?.id ?? 0,
        ownerId: session.userId,
        ownerName: await repository.usernameFor(session.userId),
        hostId: session.hostId,
        hostName: session.hostName,
        sessionId: id,
      });
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "Not allowed",
      });
      ws.close(1008, "Not allowed");
      close();
    }
  };

  ctx.ws.route("/live", onConnection);
}
