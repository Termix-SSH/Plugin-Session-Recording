import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type {
  RecordingFilters,
  SessionRecordingRecord,
  SessionRecordingRepository,
} from "./repository.js";
import type { RuleStore } from "./stores.js";
import type { AccessLog } from "./access.js";
import type { RuleEngine } from "./rule-engine.js";
import { AUDIT_PERMISSION } from "./policy.js";
import { hashPlain, plainReadStream } from "./crypto.js";
import { unwrapKey } from "./service.js";
import {
  endLiveSession,
  getLive,
  isLiveProtocol,
  listLive,
  viewerToken,
} from "./live.js";
import { checkPattern, type Rule } from "./rules.js";

// Recordings are evidence about a host, so only admins delete them.
const ADMIN_PERMISSION = "admin.plugins.manage";
const RULES_PERMISSION = "session-recording.rules";

export interface RouteDeps {
  ctx: PluginContext;
  repository: SessionRecordingRepository;
  rules: RuleStore;
  engine: RuleEngine;
  access: AccessLog;
  dataDir: () => Promise<string>;
}

function fail(ctx: PluginContext, res: Response, what: string, error: unknown) {
  ctx.log.error(
    `Failed to ${what}`,
    error instanceof Error ? error : new Error(String(error)),
  );
  if (!res.headersSent) res.status(500).json({ error: `Failed to ${what}` });
}

function idParam(req: Request): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number.parseInt(String(raw), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sizeOf(file: string | null): number | null {
  if (!file) return null;
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

async function insideData(
  file: string | null,
  dataDir: () => Promise<string>,
): Promise<string | null> {
  if (!file) return null;
  const resolved = path.resolve(file);
  const base = `${path.resolve(await dataDir())}${path.sep}`;
  return resolved.startsWith(base) ? resolved : null;
}

/** What the browser gets: no key, no file path. */
function publicRow(row: Record<string, unknown>) {
  const {
    wrappedKey,
    recordingPath,
    commands: _commands,
    dangerousActions: _dangerous,
    accessId: _accessId,
    ...rest
  } = row;
  let flags: unknown[] = [];
  try {
    flags = row.flags ? JSON.parse(String(row.flags)) : [];
  } catch {
    flags = [];
  }
  return {
    ...rest,
    flags,
    encrypted: !!wrappedKey,
    hold: row.hold === true || row.hold === 1,
    sizeBytes: sizeOf(recordingPath as string | null),
    // Older clients read recordingPath only to know a file exists.
    recordingPath: recordingPath ? "stored" : null,
  };
}

export function registerSessionRecordingRoutes(deps: RouteDeps): Router {
  const { ctx, repository, rules, engine, access, dataDir } = deps;
  const router = express.Router();
  // Every route needs session-recording.view, the same permission the rail
  // item and the writer service are gated on.
  router.use(ctx.rbac.require("view") as never);

  const actor = (res: Response): string | null => {
    const userId = ctx.currentActor();
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return null;
    }
    return userId;
  };
  const isAuditor = () => ctx.rbac.has(AUDIT_PERMISSION);

  /** The recording when the caller owns it or is an auditor, else a 404. */
  async function allowed(
    req: Request,
    res: Response,
  ): Promise<SessionRecordingRecord | null> {
    const userId = actor(res);
    if (!userId) return null;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return null;
    }
    const row = await repository.findById(id);
    if (!row || (row.userId !== userId && !(await isAuditor()))) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    return row;
  }

  async function hostNameOf(hostId: number): Promise<string | null> {
    const host = await ctx.hosts.get(hostId).catch(() => null);
    return host?.name || host?.ip || null;
  }

  const subjectOf = async (row: SessionRecordingRecord) => ({
    recordingId: row.id,
    ownerId: row.userId,
    ownerName: row.username,
    hostId: row.hostId,
    hostName: await hostNameOf(row.hostId),
  });

  /**
   * @openapi
   * /plugin-api/session-recording/:
   *   get:
   *     summary: List session recordings
   *     description: The caller's own recordings. With scope=all, everyone's, for users with session-recording.audit, filtered by userId, hostId, protocol and a from/to date range.
   *     tags:
   *       - Session Recording
   *     parameters:
   *       - in: query
   *         name: scope
   *         schema: { type: string, enum: [mine, all] }
   *     responses:
   *       200:
   *         description: List of session recordings.
   *       403:
   *         description: scope=all without session-recording.audit.
   *       500:
   *         description: Failed to fetch session recordings.
   */
  router.get("/", async (req: Request, res: Response) => {
    const userId = actor(res);
    if (!userId) return;
    try {
      if (req.query.scope === "all") {
        if (!(await isAuditor())) {
          return res.status(403).json({ error: "Needs the audit permission" });
        }
        const q = req.query;
        const filters: RecordingFilters = {
          userId: typeof q.userId === "string" ? q.userId : undefined,
          hostId: Number(q.hostId) || undefined,
          protocol: typeof q.protocol === "string" ? q.protocol : undefined,
          from: typeof q.from === "string" ? q.from : undefined,
          to: typeof q.to === "string" ? q.to : undefined,
          limit: Number(q.limit) || undefined,
          offset: Number(q.offset) || undefined,
        };
        const rows = await repository.listAll(filters);
        return res.json({ logs: rows.map((row) => publicRow({ ...row })) });
      }
      const rows = await repository.listByUserIdWithHost(userId);
      res.json({ logs: rows.map((row) => publicRow({ ...row })) });
    } catch (error) {
      fail(ctx, res, "fetch session recordings", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/session-recording/live:
   *   get:
   *     summary: List live sessions of every user
   *     description: Needs session-recording.audit, plus ssh-terminal.monitor and remote-desktop.monitor for those session types.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: Live sessions, newest first.
   *       403:
   *         description: Needs the audit permission.
   */
  router.get("/live", async (_req: Request, res: Response) => {
    if (!actor(res)) return;
    if (!(await isAuditor())) {
      return res.status(403).json({ error: "Needs the audit permission" });
    }
    try {
      const sessions = await listLive(ctx);
      const names = new Map<string, string | null>();
      for (const session of sessions) {
        if (!names.has(session.userId)) {
          names.set(
            session.userId,
            await repository.usernameFor(session.userId),
          );
        }
      }
      res.json({
        sessions: sessions.map((session) => ({
          ...session,
          username: names.get(session.userId) ?? null,
        })),
      });
    } catch (error) {
      fail(ctx, res, "list live sessions", error);
    }
  });

  async function liveTarget(req: Request, res: Response) {
    if (!actor(res)) return null;
    if (!(await isAuditor())) {
      res.status(403).json({ error: "Needs the audit permission" });
      return null;
    }
    const protocol = req.params.protocol;
    const id = String(req.params.id ?? "");
    if (!isLiveProtocol(protocol) || !/^[A-Za-z0-9$_.:-]{1,120}$/.test(id)) {
      res.status(400).json({ error: "Invalid session" });
      return null;
    }
    const session = await getLive(ctx, protocol, id).catch(() => null);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return null;
    }
    return { protocol, id, session };
  }

  const liveSubject = async (target: {
    id: string;
    session: { userId: string; hostId: number; hostName: string };
  }) => {
    const recording =
      (await repository.findBySessionId(target.id).catch(() => null)) ?? null;
    return {
      recordingId: recording?.id ?? 0,
      ownerId: target.session.userId,
      ownerName: await repository.usernameFor(target.session.userId),
      hostId: target.session.hostId,
      hostName: target.session.hostName,
      sessionId: target.id,
      recording,
    };
  };

  /**
   * @openapi
   * /plugin-api/session-recording/live/{protocol}/{id}/end:
   *   post:
   *     summary: End someone's live session
   *     description: Needs session-recording.audit and the provider's monitor permission. Audited, and the reason is kept on the recording.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: Ended.
   *       403:
   *         description: Not allowed.
   *       404:
   *         description: No such live session.
   */
  router.post(
    "/live/:protocol/:id/end",
    async (req: Request, res: Response) => {
      const target = await liveTarget(req, res);
      if (!target) return;
      const given =
        typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      const reason = (given || "Ended by an auditor").slice(0, 200);
      try {
        await endLiveSession(ctx, target.protocol, target.id, reason);
      } catch (error) {
        return res.status(403).json({
          error: error instanceof Error ? error.message : "Not allowed",
        });
      }
      const subject = await liveSubject(target);
      if (subject.recording) {
        await repository
          .setTermination(subject.recording.id, reason)
          .catch(() => {});
      }
      await access.record("ended-live", subject, req, reason);
      res.json({ success: true });
    },
  );

  /**
   * @openapi
   * /plugin-api/session-recording/live/{protocol}/{id}/viewer:
   *   post:
   *     summary: A read only viewer token for a live remote desktop session
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: The token for the remote display.
   *       403:
   *         description: Not allowed.
   */
  router.post(
    "/live/:protocol/:id/viewer",
    async (req: Request, res: Response) => {
      const target = await liveTarget(req, res);
      if (!target) return;
      if (target.protocol === "ssh") {
        return res.status(400).json({ error: "Watch SSH over the socket" });
      }
      try {
        const token = await viewerToken(ctx, target.protocol, target.id);
        if (!token) return res.status(404).json({ error: "Not available" });
        await access.record("watched-live", await liveSubject(target), req);
        res.json({ token });
      } catch (error) {
        res.status(403).json({
          error: error instanceof Error ? error.message : "Not allowed",
        });
      }
    },
  );

  const requireRules = async (res: Response): Promise<string | null> => {
    const userId = actor(res);
    if (!userId) return null;
    if (!(await ctx.rbac.has(RULES_PERMISSION))) {
      res.status(403).json({ error: "Needs the rules permission" });
      return null;
    }
    return userId;
  };

  function readRule(body: unknown): Omit<Rule, "id"> {
    const input = (body ?? {}) as Record<string, unknown>;
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 120) throw new Error("Give the rule a name");
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const regex = input.regex === true;
    checkPattern(pattern, regex);
    return {
      name,
      pattern,
      regex,
      target: input.target === "output" ? "output" : "input",
      hosts: input.hosts === "privileged" ? "privileged" : "all",
      severity:
        input.severity === "info" || input.severity === "critical"
          ? input.severity
          : "warning",
      action: input.action === "end" ? "end" : "alert",
      enabled: input.enabled !== false,
    };
  }

  /**
   * @openapi
   * /plugin-api/session-recording/rules:
   *   get:
   *     summary: List command alert rules
   *     description: Needs session-recording.rules.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: The rules.
   *   post:
   *     summary: Add a command alert rule
   *     description: name, pattern, regex, target (input or output), hosts (all or privileged), severity, action (alert or end) and enabled. Needs session-recording.rules.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: The new rule.
   *       400:
   *         description: The rule is not valid.
   */
  router.get("/rules", async (_req: Request, res: Response) => {
    if (!(await requireRules(res))) return;
    try {
      res.json({ rules: await rules.list() });
    } catch (error) {
      fail(ctx, res, "list rules", error);
    }
  });

  router.post("/rules", async (req: Request, res: Response) => {
    const userId = await requireRules(res);
    if (!userId) return;
    let input: Omit<Rule, "id">;
    try {
      input = readRule(req.body);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
    try {
      const rule = await rules.create(input, userId);
      engine.reload();
      await ctx.audit
        .record({
          action: "session_rule_created",
          resourceType: "session_rule",
          resourceId: String(rule.id),
          resourceName: rule.name,
          success: true,
          request: req,
        })
        .catch(() => {});
      res.json({ rule });
    } catch (error) {
      fail(ctx, res, "save the rule", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/session-recording/rules/{id}:
   *   put:
   *     summary: Change a command alert rule
   *     description: Needs session-recording.rules.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: Saved.
   *       400:
   *         description: The rule is not valid.
   *       404:
   *         description: No such rule.
   *   delete:
   *     summary: Delete a command alert rule
   *     description: Needs session-recording.rules.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: Deleted.
   */
  router.put("/rules/:id", async (req: Request, res: Response) => {
    if (!(await requireRules(res))) return;
    const id = idParam(req);
    if (!id || !(await rules.get(id))) {
      return res.status(404).json({ error: "Not found" });
    }
    let input: Omit<Rule, "id">;
    try {
      input = readRule(req.body);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
    try {
      await rules.update(id, input);
      engine.reload();
      await ctx.audit
        .record({
          action: "session_rule_updated",
          resourceType: "session_rule",
          resourceId: String(id),
          resourceName: input.name,
          success: true,
          request: req,
        })
        .catch(() => {});
      res.json({ rule: await rules.get(id) });
    } catch (error) {
      fail(ctx, res, "save the rule", error);
    }
  });

  router.delete("/rules/:id", async (req: Request, res: Response) => {
    if (!(await requireRules(res))) return;
    const id = idParam(req);
    const rule = id ? await rules.get(id) : null;
    if (!id || !rule) return res.status(404).json({ error: "Not found" });
    try {
      await rules.remove(id);
      engine.reload();
      await ctx.audit
        .record({
          action: "session_rule_deleted",
          resourceType: "session_rule",
          resourceId: String(id),
          resourceName: rule.name,
          success: true,
          request: req,
        })
        .catch(() => {});
      res.json({ success: true });
    } catch (error) {
      fail(ctx, res, "delete the rule", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/session-recording/{id}:
   *   get:
   *     summary: Get session recording metadata
   *     description: The caller's own recording, or anyone's for session-recording.audit.
   *     tags:
   *       - Session Recording
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200:
   *         description: Session recording metadata.
   *       404:
   *         description: Session recording not found.
   *       500:
   *         description: Failed to fetch session recording.
   */
  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const row = await allowed(req, res);
      if (!row) return;
      res.json({ log: publicRow({ ...row }) });
    } catch (error) {
      fail(ctx, res, "fetch session recording", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/session-recording/{id}/content:
   *   get:
   *     summary: Get session recording content
   *     description: The plain recording, decrypted on the way. purpose=download marks it as a download in the access history. Every read is audited.
   *     tags:
   *       - Session Recording
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *       - in: query
   *         name: purpose
   *         schema: { type: string, enum: [view, download] }
   *     responses:
   *       200:
   *         description: Raw recording content.
   *       404:
   *         description: Session recording or file not found.
   *       500:
   *         description: Failed to read session recording.
   */
  router.get("/:id/content", async (req: Request, res: Response) => {
    try {
      const row = await allowed(req, res);
      if (!row) return;
      if (!row.recordingPath) {
        return res.status(404).json({ error: "No recording file" });
      }
      const file = await insideData(row.recordingPath, dataDir);
      if (!file) return res.status(403).json({ error: "Forbidden" });
      if (!fs.existsSync(file)) {
        return res.status(404).json({ error: "File not found" });
      }
      const key = await unwrapKey(ctx, row.wrappedKey);

      const format =
        row.format ??
        (row.recordingPath.endsWith(".cast") ? "asciicast" : "text");
      const contentType =
        format === "guacamole"
          ? "application/vnd.apache.guacamole.recording"
          : format === "asciicast"
            ? "application/x-asciicast"
            : "text/plain";
      await access.record(
        req.query.purpose === "download" ? "downloaded" : "viewed",
        await subjectOf(row),
        req,
      );
      // Remote desktop recordings can be large, so stream instead of
      // reading the whole file first.
      res.type(contentType);
      res.setHeader("Cache-Control", "no-store");
      const stream = plainReadStream(file, key);
      stream.on("error", (error) => {
        ctx.log.error("Failed to stream session recording", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read session recording" });
        } else {
          res.destroy(error);
        }
      });
      stream.pipe(res);
    } catch (error) {
      fail(ctx, res, "read session recording", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/session-recording/{id}/access:
   *   get:
   *     summary: Who watched, downloaded or checked a recording
   *     description: Needs session-recording.audit.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: Access entries, newest first.
   *       403:
   *         description: Needs the audit permission.
   */
  router.get("/:id/access", async (req: Request, res: Response) => {
    try {
      if (!actor(res)) return;
      if (!(await isAuditor())) {
        return res.status(403).json({ error: "Needs the audit permission" });
      }
      const row = await allowed(req, res);
      if (!row) return;
      res.json({ entries: await access.list(row.id) });
    } catch (error) {
      fail(ctx, res, "read the access history", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/session-recording/{id}/verify:
   *   post:
   *     summary: Check a recording was not changed
   *     description: Recomputes the SHA-256 of the plain recording and compares it with the one saved when it ended. A changed recording alerts auditors.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: status is ok, changed, unknown (no saved hash) or missing (no file).
   */
  router.post("/:id/verify", async (req: Request, res: Response) => {
    try {
      const row = await allowed(req, res);
      if (!row) return;
      const result = await verifyRecording(deps, row);
      await access.record("verified", await subjectOf(row), req, result.status);
      res.json(result);
    } catch (error) {
      fail(ctx, res, "check the recording", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/session-recording/{id}/hold:
   *   put:
   *     summary: Put a recording on hold or take it off
   *     description: A held recording is never removed by retention or deleted by hand. Needs session-recording.audit.
   *     tags:
   *       - Session Recording
   *     responses:
   *       200:
   *         description: The new hold state.
   *       400:
   *         description: hold must be true or false.
   *       403:
   *         description: Needs the audit permission.
   */
  router.put("/:id/hold", async (req: Request, res: Response) => {
    try {
      if (!actor(res)) return;
      if (!(await isAuditor())) {
        return res.status(403).json({ error: "Needs the audit permission" });
      }
      const row = await allowed(req, res);
      if (!row) return;
      const hold = req.body?.hold;
      if (typeof hold !== "boolean") {
        return res.status(400).json({ error: "hold must be true or false" });
      }
      await repository.setHold(row.id, hold);
      await access.record(
        hold ? "hold-on" : "hold-off",
        await subjectOf(row),
        req,
      );
      res.json({ hold });
    } catch (error) {
      fail(ctx, res, "change the hold", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/session-recording/{id}:
   *   delete:
   *     summary: Delete session recording
   *     description: Deletes a recording and its file. Admins only, since a recording is a record of what happened on the host, and never one on hold.
   *     tags:
   *       - Session Recording
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200:
   *         description: Session recording deleted.
   *       403:
   *         description: Only admins can delete recordings.
   *       404:
   *         description: Session recording not found.
   *       409:
   *         description: The recording is on hold.
   *       500:
   *         description: Failed to delete session recording.
   */
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      if (!actor(res)) return;
      if (!(await ctx.rbac.has(ADMIN_PERMISSION))) {
        return res
          .status(403)
          .json({ error: "Only admins can delete recordings" });
      }
      const row = await allowed(req, res);
      if (!row) return;
      if (row.hold) {
        return res.status(409).json({ error: "This recording is on hold" });
      }
      await repository.deleteById(row.id);
      const file = await insideData(row.recordingPath, dataDir);
      if (file && fs.existsSync(file)) {
        await fs.promises.unlink(file).catch(() => {});
      }
      await ctx.audit
        .record({
          action: "recording_deleted",
          resourceType: "session_recording",
          resourceId: String(row.id),
          resourceName: `${row.username ?? row.userId ?? "unknown"} on #${row.hostId}`,
          success: true,
          request: req,
        })
        .catch(() => {});
      res.json({ success: true });
    } catch (error) {
      fail(ctx, res, "delete session recording", error);
    }
  });

  return router;
}

export type VerifyStatus = "ok" | "changed" | "unknown" | "missing";

/** Recomputes a recording's hash and alerts auditors when it changed. */
export async function verifyRecording(
  deps: Pick<RouteDeps, "ctx" | "dataDir">,
  row: SessionRecordingRecord,
): Promise<{ status: VerifyStatus; sha256: string | null }> {
  const file = await insideData(row.recordingPath, deps.dataDir);
  if (!file || !fs.existsSync(file)) return { status: "missing", sha256: null };
  const key = await unwrapKey(deps.ctx, row.wrappedKey);
  let actual: string;
  try {
    actual = await hashPlain(file, key);
  } catch {
    actual = "unreadable";
  }
  if (!row.sha256) return { status: "unknown", sha256: actual };
  if (actual === row.sha256) return { status: "ok", sha256: actual };
  await deps.ctx.notify
    .send({
      title: `A session recording was changed (#${row.id})`,
      body: `${row.username ?? row.userId ?? "unknown"} on host #${row.hostId}`,
      severity: "critical",
      category: "session-recording.tampered",
      audience: { permission: AUDIT_PERMISSION },
      dedupeKey: `tampered:${row.id}`,
      link: { tab: "session-logs" },
      context: { hostId: row.hostId },
    })
    .catch(() => {});
  return { status: "changed", sha256: actual };
}
