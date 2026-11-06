import type { Request } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { SessionRecordingRepository } from "./repository.js";
import type { AccessAction, AccessStore } from "./stores.js";
import { AUDIT_PERMISSION, accessAlertMode } from "./policy.js";

const AUDIT_ACTION: Record<AccessAction, string> = {
  viewed: "recording_viewed",
  downloaded: "recording_downloaded",
  verified: "recording_verified",
  "watched-live": "session_watched_live",
  "ended-live": "session_terminated_by_auditor",
  "hold-on": "recording_hold_on",
  "hold-off": "recording_hold_off",
};

const ALERT_LABEL: Partial<Record<AccessAction, string>> = {
  viewed: "watched",
  downloaded: "downloaded",
  "watched-live": "is watching live",
  "ended-live": "ended",
};

export interface AccessSubject {
  /** The recording row, or 0 for a live session with no recording yet. */
  recordingId: number;
  ownerId: string | null;
  ownerName: string | null;
  hostId: number;
  hostName: string | null;
  /** Session id for live actions. */
  sessionId?: string;
}

export type AccessLog = ReturnType<typeof createAccessLog>;

/**
 * Writes one access to the audit log (which Audit Tools forwards to a SIEM),
 * to the recording's own history, and alerts auditors when the admin asked.
 */
export function createAccessLog(
  ctx: PluginContext,
  store: AccessStore,
  repository: SessionRecordingRepository,
) {
  const lastAlert = new Map<string, number>();

  return {
    list: (recordingId: number) => store.list(recordingId),

    async record(
      action: AccessAction,
      subject: AccessSubject,
      req?: Request,
      details?: string,
    ): Promise<void> {
      const viewer = ctx.currentActor() ?? null;
      const viewerName = viewer ? await repository.usernameFor(viewer) : null;
      const host = subject.hostName ?? `#${subject.hostId}`;
      const owner = subject.ownerName ?? subject.ownerId ?? "unknown";

      await ctx.audit
        .record({
          action: AUDIT_ACTION[action],
          resourceType: "session_recording",
          resourceId: subject.recordingId
            ? String(subject.recordingId)
            : subject.sessionId,
          resourceName: `${owner} on ${host}`,
          details,
          success: true,
          request: req,
        })
        .catch(() => {});

      if (subject.recordingId) {
        await store
          .add({
            recordingId: subject.recordingId,
            userId: viewer,
            username: viewerName,
            action,
            ip: req?.ip ?? null,
          })
          .catch(() => {});
      }

      const label = ALERT_LABEL[action];
      if (!label || !viewer) return;
      const mode = await accessAlertMode(ctx);
      if (mode === "off") return;
      if (mode === "others" && viewer === subject.ownerId) return;
      const hour = Math.floor(Date.now() / 3_600_000);
      const key = `${action}:${subject.recordingId || subject.sessionId}:${viewer}:${hour}`;
      if (lastAlert.has(key)) return;
      lastAlert.set(key, Date.now());
      if (lastAlert.size > 2000) lastAlert.clear();
      await ctx.notify
        .send({
          title: `${viewerName ?? viewer} ${label} a session of ${owner} on ${host}`,
          severity: action === "ended-live" ? "warning" : "info",
          category: "session-recording.accessed",
          audience: { permission: AUDIT_PERMISSION },
          dedupeKey: key,
          link: { tab: "session-logs" },
          context: { hostId: subject.hostId, hostName: host },
        })
        .catch(() => {});
    },
  };
}
