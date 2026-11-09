import { desc, eq } from "drizzle-orm";
import type { PluginDatabase } from "@termix-ssh/plugin-sdk/backend";
import type { Rule } from "./rules.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type AccessAction =
  | "viewed"
  | "downloaded"
  | "verified"
  | "watched-live"
  | "ended-live"
  | "hold-on"
  | "hold-off";

export interface AccessEntry {
  id: number;
  recordingId: number;
  userId: string | null;
  username: string | null;
  action: AccessAction;
  at: string;
  ip: string | null;
}

export type AccessStore = ReturnType<typeof createAccessStore>;

/** The access history of each recording. Rows outlive the recording. */
export function createAccessStore(db: PluginDatabase, table: Table) {
  const client = () => db.client<Drizzle>();
  return {
    async add(entry: Omit<AccessEntry, "id" | "at">): Promise<void> {
      const drizzle = await client();
      await drizzle
        .insert(table)
        .values({ ...entry, at: new Date().toISOString() });
      await db.persist({ lazy: true });
    },

    async list(recordingId: number, limit = 200): Promise<AccessEntry[]> {
      const drizzle = await client();
      return drizzle
        .select()
        .from(table)
        .where(eq(table.recordingId, recordingId))
        .orderBy(desc(table.id))
        .limit(limit);
    },
  };
}

export type RuleStore = ReturnType<typeof createRuleStore>;

type RuleInput = Omit<Rule, "id">;

function toRule(row: Record<string, unknown>): Rule {
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    pattern: String(row.pattern ?? ""),
    regex: row.regex === true || row.regex === 1,
    target: row.target === "output" ? "output" : "input",
    hosts: row.hosts === "privileged" ? "privileged" : "all",
    severity:
      row.severity === "info" || row.severity === "critical"
        ? row.severity
        : "warning",
    action: row.action === "end" ? "end" : "alert",
    enabled: row.enabled === true || row.enabled === 1,
  };
}

export function createRuleStore(db: PluginDatabase, table: Table) {
  const client = () => db.client<Drizzle>();
  return {
    async list(): Promise<Rule[]> {
      const drizzle = await client();
      const rows = await drizzle.select().from(table).orderBy(table.id);
      return rows.map(toRule);
    },

    async get(id: number): Promise<Rule | null> {
      const drizzle = await client();
      const rows = await drizzle
        .select()
        .from(table)
        .where(eq(table.id, id))
        .limit(1);
      return rows[0] ? toRule(rows[0]) : null;
    },

    async create(input: RuleInput, createdBy: string | null): Promise<Rule> {
      const drizzle = await client();
      await drizzle.insert(table).values({ ...input, createdBy });
      const rows = await drizzle
        .select()
        .from(table)
        .orderBy(desc(table.id))
        .limit(1);
      await db.persist();
      return toRule(rows[0]);
    },

    async update(id: number, input: Partial<RuleInput>): Promise<void> {
      const drizzle = await client();
      await drizzle.update(table).set(input).where(eq(table.id, id));
      await db.persist();
    },

    async remove(id: number): Promise<void> {
      const drizzle = await client();
      await drizzle.delete(table).where(eq(table.id, id));
      await db.persist();
    },
  };
}
