import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { SessionRecordingRepository } from "./repository.js";
import { adoptRecordingFile } from "./files.js";
import { fileHeader, newRecordingKey, sealFile, sealFrame } from "./crypto.js";
import { encryptionOn, isForced } from "./policy.js";
import type { RuleEngine } from "./rule-engine.js";

/**
 * recordings.writer v1, the service ssh-terminal calls to record sessions.
 * 1.1 added enabledFor, for a caller that records outside this plugin.
 * 1.2 added isForced, so a caller can refuse to stop a required recording.
 *
 * One call per already-batched chunk (ssh-terminal coalesces on a 300ms
 * trailing edge, issue #1049): mkdir and writeFile on the first append,
 * appendFile after that, never per chunk.
 */
export interface RecordingSink {
  append: (chunk: string) => Promise<void>;
  persist: (summary: {
    endedAt: number;
    durationSeconds: number;
    terminatedByOwner: boolean;
    terminationReason: string | null;
  }) => Promise<void>;
  discard: () => void;
}

export interface RecordingsWriterV1 {
  /**
   * Whether the host's recording switch is on, or an admin made recording
   * required, for a caller that has to set up recording before a session
   * exists (remote desktop tells guacd).
   */
  enabledFor: (hostId: number) => Promise<boolean>;
  /** True when an admin made recording this host required. */
  isForced: (hostId: number) => Promise<boolean>;
  /** Null when recording is off for this user or host. */
  open: (meta: {
    sessionId: string;
    hostId: number;
    userId: string;
    protocol: "ssh";
    format: "asciicast";
    startedAt: number;
  }) => Promise<RecordingSink | null>;
  /**
   * Inserts a row for a recording a caller already wrote to disk itself
   * (remote desktop's guacd recordings), rather than streaming through
   * open()/append(). The caller already decided to record. The file is
   * moved under this plugin's data folder, where playback reads it, then
   * encrypted when encryption is on.
   */
  createFinished: (input: {
    hostId: number;
    userId: string;
    startedAt: string;
    endedAt: string;
    duration: number | null;
    recordingPath: string;
    protocol: string;
    format: string;
  }) => Promise<{ id: number }>;
}

/** A sealed key for a new recording, or nulls when encryption is off. */
async function recordingKey(
  ctx: PluginContext,
): Promise<{ key: Buffer | null; wrappedKey: string | null }> {
  if (!(await encryptionOn(ctx))) return { key: null, wrappedKey: null };
  const key = newRecordingKey();
  return { key, wrappedKey: await ctx.secrets.seal(key.toString("base64")) };
}

/** The key of a stored recording, or null for a plain one. */
export async function unwrapKey(
  ctx: PluginContext,
  wrappedKey: string | null | undefined,
): Promise<Buffer | null> {
  if (!wrappedKey) return null;
  const raw = await ctx.secrets.unseal(wrappedKey);
  if (!raw) throw new Error("The recording key can't be read");
  return Buffer.from(raw, "base64");
}

export function createRecordingsWriter(
  ctx: PluginContext,
  repository: SessionRecordingRepository,
  rules: RuleEngine,
): RecordingsWriterV1 {
  const forced = (hostId: number) => isForced(ctx, hostId);
  const enabledFor = async (hostId: number) =>
    (await forced(hostId)) ||
    (await ctx.settings.getHost<boolean>(hostId, "enableSessionRecording")) !==
      false;

  return {
    enabledFor,
    isForced: forced,

    async open(meta) {
      if (!(await enabledFor(meta.hostId))) return null;

      const dataDir = await ctx.files.dataDir();
      const dir = path.join(dataDir, "session_logs", meta.userId);
      const filePath = path.join(dir, `${meta.sessionId}.cast`);
      let wroteFirst = false;
      let discarded = false;
      const hash = crypto.createHash("sha256");
      const { key, wrappedKey } = await recordingKey(ctx);

      const username = await repository.usernameFor(meta.userId);
      const row = await repository.create({
        hostId: meta.hostId,
        userId: meta.userId,
        username,
        startedAt: new Date(meta.startedAt).toISOString(),
        recordingPath: filePath,
        protocol: meta.protocol,
        format: meta.format,
        wrappedKey,
      });
      const scanner = await rules.scannerFor({
        recordingId: row.id,
        sessionId: meta.sessionId,
        hostId: meta.hostId,
        userId: meta.userId,
        username,
      });

      return {
        async append(chunk: string) {
          if (discarded) return;
          const plain = Buffer.from(chunk, "utf8");
          hash.update(plain);
          scanner?.scan(chunk);
          const bytes = key ? sealFrame(key, plain) : plain;
          if (!wroteFirst) {
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(
              filePath,
              key ? Buffer.concat([fileHeader(), bytes]) : bytes,
              { mode: 0o600 },
            );
            wroteFirst = true;
          } else {
            await fs.appendFile(filePath, bytes);
          }
        },

        async persist(summary) {
          if (discarded) return;
          await repository.updateEnded(row.id, {
            endedAt: new Date(summary.endedAt).toISOString(),
            duration: summary.durationSeconds,
            terminatedByOwner: summary.terminatedByOwner,
            terminationReason: summary.terminationReason,
            // A copy, since persist runs again when the session goes on.
            sha256: hash.copy().digest("hex"),
            ...(scanner?.flagsJson() ? { flags: scanner.flagsJson() } : {}),
          });
        },

        discard() {
          discarded = true;
          void repository.deleteById(row.id).catch(() => {});
          if (wroteFirst) void fs.unlink(filePath).catch(() => {});
        },
      };
    },

    async createFinished(input) {
      const username = await repository.usernameFor(input.userId);
      const recordingPath = await adoptRecordingFile(
        input.recordingPath,
        await ctx.files.dataDir(),
      ).catch(() => input.recordingPath);
      let sealed: { wrappedKey: string | null; sha256: string | null } = {
        wrappedKey: null,
        sha256: null,
      };
      try {
        const { key, wrappedKey } = await recordingKey(ctx);
        const sha256 = await sealFile(recordingPath, key);
        sealed = { wrappedKey, sha256 };
      } catch (error) {
        // A missing or unreadable file keeps its row, unsealed.
        ctx.log.warn(
          `Could not seal a remote desktop recording: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const row = await repository.create({
        ...input,
        ...sealed,
        recordingPath,
        username,
      });
      return { id: row.id };
    },
  };
}
