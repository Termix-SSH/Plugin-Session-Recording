import fs from "node:fs/promises";
import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import type { SessionRecordingRepository } from "./repository.js";

const USAGE_WARN_BYTES = 1024 * 1024 * 1024;

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

/** The acting user's recordings of one host, for the host page. */
export function registerOperations(
  ctx: PluginContext,
  repository: SessionRecordingRepository,
): void {
  if (typeof ctx.operations?.register !== "function") return;

  ctx.operations.register("session-recording.list", {
    run: async (_input, context) => {
      const userId = ctx.currentActor();
      if (!userId) throw new Error("This needs a user");
      const hostId = requireHost(context);
      const rows = (await repository.listByUserIdWithHost(userId)).filter(
        (row) => row.hostId === hostId,
      );
      return {
        summary: `${rows.length} recordings`,
        data: {
          rows: rows.slice(0, 100).map((row) => {
            const record = row as unknown as Record<string, unknown>;
            return {
              id: String(row.id),
              protocol: String(record.protocol ?? "ssh"),
              started: String(record.startedAt ?? ""),
              ended: String(record.endedAt ?? ""),
            };
          }),
        },
      };
    },
  });

  ctx.operations.register("session-recording.usage", {
    run: async (_input, context) => {
      const userId = ctx.currentActor();
      if (!userId) throw new Error("This needs a user");
      const hostId = requireHost(context);
      const rows = (await repository.listByUserIdWithHost(userId)).filter(
        (row) => row.hostId === hostId,
      );
      let bytes = 0;
      for (const row of rows) {
        if (!row.recordingPath) continue;
        const stat = await fs.stat(row.recordingPath).catch(() => null);
        if (stat) bytes += stat.size;
      }
      const label = `${rows.length} recordings, ${Math.round(bytes / 1048576)} MB`;
      return {
        summary: label,
        data: {
          value: bytes,
          status: bytes > USAGE_WARN_BYTES ? "warn" : "ok",
          label,
        },
      };
    },
  });
}
