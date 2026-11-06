import { and, desc, eq, gte, like, lt, lte, type SQL } from "drizzle-orm";
import type {
  PluginDatabase,
  PluginHosts,
} from "@termix-ssh/plugin-sdk/backend";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The table comes from ctx.db.define, which the SDK hands back untyped, and
// the drizzle handle is the server's own. Typed at this module's edge instead.
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SessionRecordingRecord {
  id: number;
  hostId: number;
  userId: string | null;
  username: string | null;
  startedAt: string;
  endedAt: string | null;
  duration: number | null;
  recordingPath: string | null;
  protocol: string;
  format: string | null;
  terminatedByOwner: boolean | null;
  terminationReason: string | null;
  wrappedKey: string | null;
  sha256: string | null;
  hold: boolean | null;
  flags: string | null;
}

export interface SessionRecordingListRecord {
  id: number;
  hostId: number;
  userId: string | null;
  startedAt: string;
  endedAt: string | null;
  duration: number | null;
  recordingPath: string | null;
  protocol: string;
  format: string | null;
  username: string | null;
  hostName: string | null;
  hostIp: string | null;
  hold?: boolean | null;
  flags?: string | null;
  sha256?: string | null;
  wrappedKey?: string | null;
  terminationReason?: string | null;
}

/** Filters for the auditor list of everyone's recordings. */
export interface RecordingFilters {
  userId?: string;
  hostId?: number;
  protocol?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface SessionRecordingCreateInput {
  hostId: number;
  userId: string;
  username?: string | null;
  startedAt: string;
  endedAt?: string | null;
  duration?: number | null;
  recordingPath?: string | null;
  protocol?: string | null;
  format?: string | null;
  terminatedByOwner?: boolean | null;
  terminationReason?: string | null;
  wrappedKey?: string | null;
  sha256?: string | null;
}

export type SessionRecordingRepository = ReturnType<
  typeof createSessionRecordingRepository
>;

/**
 * Written without RETURNING so it runs the same on all three engines: an
 * insert is read back by a marker key it was given, an update by its id.
 */
export function createSessionRecordingRepository(
  db: PluginDatabase,
  table: Table,
  hosts: PluginHosts,
) {
  const client = () => db.client<Drizzle>();

  async function usernameFor(userId: string): Promise<string | null> {
    const { users } = await db.refs<{ users: Table }>();
    const drizzle = await client();
    const rows = await drizzle
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId));
    return rows[0]?.username ?? null;
  }

  async function withHostNames(
    rows: SessionRecordingListRecord[],
  ): Promise<SessionRecordingListRecord[]> {
    const list = await hosts.list();
    const byId = new Map(list.map((host) => [host.id, host]));
    return rows.map((row) => {
      const host = byId.get(row.hostId);
      return { ...row, hostName: host?.name ?? null, hostIp: host?.ip ?? null };
    });
  }

  return {
    usernameFor,

    /**
     * Inserts a row and returns it. recordingPath is the caller's read-back
     * key: every caller sets it to something unique (the file path or a
     * session id) before insert, since MySQL has no RETURNING to read a new
     * id back with.
     */
    async create(
      input: SessionRecordingCreateInput & { recordingPath: string },
    ): Promise<SessionRecordingRecord> {
      const drizzle = await client();
      await drizzle.insert(table).values(input);
      const rows = await drizzle
        .select()
        .from(table)
        .where(eq(table.recordingPath, input.recordingPath))
        .orderBy(desc(table.id))
        .limit(1);
      await db.persist();
      return rows[0];
    },

    async updateEnded(
      id: number,
      input: {
        endedAt: string;
        duration: number | null;
        terminatedByOwner?: boolean;
        terminationReason?: string | null;
        sha256?: string | null;
        flags?: string | null;
      },
    ): Promise<void> {
      const drizzle = await client();
      await drizzle.update(table).set(input).where(eq(table.id, id));
      await db.persist();
    },

    async findByIdForUser(
      userId: string,
      id: number,
    ): Promise<SessionRecordingRecord | null> {
      const drizzle = await client();
      const rows = await drizzle
        .select()
        .from(table)
        .where(and(eq(table.id, id), eq(table.userId, userId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findPathByIdForUser(
      userId: string,
      id: number,
    ): Promise<{
      id: number;
      recordingPath: string | null;
      format: string | null;
    } | null> {
      const drizzle = await client();
      const rows = await drizzle
        .select({
          id: table.id,
          recordingPath: table.recordingPath,
          format: table.format,
        })
        .from(table)
        .where(and(eq(table.id, id), eq(table.userId, userId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async listByUserIdWithHost(
      userId: string,
    ): Promise<SessionRecordingListRecord[]> {
      const drizzle = await client();
      const rows = (await drizzle
        .select()
        .from(table)
        .where(eq(table.userId, userId))
        .orderBy(desc(table.startedAt))) as SessionRecordingListRecord[];
      return withHostNames(rows);
    },

    /** Everyone's recordings, newest first, for auditors. */
    async listAll(
      filters: RecordingFilters = {},
    ): Promise<SessionRecordingListRecord[]> {
      const drizzle = await client();
      const where: SQL[] = [];
      if (filters.userId) where.push(eq(table.userId, filters.userId));
      if (filters.hostId) where.push(eq(table.hostId, filters.hostId));
      if (filters.protocol) where.push(eq(table.protocol, filters.protocol));
      if (filters.from) where.push(gte(table.startedAt, filters.from));
      if (filters.to) where.push(lte(table.startedAt, filters.to));
      const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
      let query = drizzle.select().from(table);
      if (where.length) query = query.where(and(...where));
      const rows = (await query
        .orderBy(desc(table.startedAt))
        .limit(limit)
        .offset(
          Math.max(filters.offset ?? 0, 0),
        )) as SessionRecordingListRecord[];
      return withHostNames(rows);
    },

    async findById(id: number): Promise<SessionRecordingRecord | null> {
      const drizzle = await client();
      const rows = await drizzle
        .select()
        .from(table)
        .where(eq(table.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async setFlags(id: number, flags: string): Promise<void> {
      const drizzle = await client();
      await drizzle.update(table).set({ flags }).where(eq(table.id, id));
      await db.persist({ lazy: true });
    },

    async setHash(id: number, sha256: string): Promise<void> {
      const drizzle = await client();
      await drizzle.update(table).set({ sha256 }).where(eq(table.id, id));
      await db.persist();
    },

    async setHold(id: number, hold: boolean): Promise<void> {
      const drizzle = await client();
      await drizzle.update(table).set({ hold }).where(eq(table.id, id));
      await db.persist();
    },

    async setTermination(id: number, reason: string): Promise<void> {
      const drizzle = await client();
      await drizzle
        .update(table)
        .set({ terminationReason: reason })
        .where(eq(table.id, id));
      await db.persist();
    },

    /** The recording a live session writes to, found by its file name. */
    async findBySessionId(
      sessionId: string,
    ): Promise<SessionRecordingRecord | null> {
      if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
      const drizzle = await client();
      const rows = await drizzle
        .select()
        .from(table)
        .where(like(table.recordingPath, `%${sessionId}.cast`))
        .orderBy(desc(table.id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listPathsOlderThan(
      cutoff: string,
    ): Promise<Array<{ id: number; recordingPath: string | null }>> {
      const drizzle = await client();
      return drizzle
        .select({ id: table.id, recordingPath: table.recordingPath })
        .from(table)
        .where(and(lt(table.startedAt, cutoff), eq(table.hold, false)));
    },

    async deleteForUser(userId: string, id: number): Promise<boolean> {
      const drizzle = await client();
      const existing = await drizzle
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.id, id), eq(table.userId, userId)))
        .limit(1);
      if (existing.length === 0) return false;
      await drizzle
        .delete(table)
        .where(and(eq(table.id, id), eq(table.userId, userId)));
      await db.persist();
      return true;
    },

    async deleteById(id: number): Promise<boolean> {
      const drizzle = await client();
      const existing = await drizzle
        .select({ id: table.id })
        .from(table)
        .where(eq(table.id, id))
        .limit(1);
      if (existing.length === 0) return false;
      await drizzle.delete(table).where(eq(table.id, id));
      await db.persist();
      return true;
    },

    /**
     * Detaches recordings from a user being deleted instead of removing them.
     * A recording is evidence about the host as much as about the person, and
     * the file stays on disk regardless of the row.
     */
    async anonymizeByUserId(userId: string): Promise<void> {
      const drizzle = await client();
      await drizzle
        .update(table)
        .set({ userId: null })
        .where(eq(table.userId, userId));
      await db.persist();
    },
  };
}
