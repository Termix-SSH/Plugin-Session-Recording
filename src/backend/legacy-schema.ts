import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PluginDatabase } from "@termix-ssh/plugin-sdk/backend";

export async function repairLegacyRecordingSchema(db: PluginDatabase) {
  if (db.dialect !== "sqlite") return;

  const client = await db.client<BetterSQLite3Database>();
  const columns = client.all<{ name: string }>(
    sql`PRAGMA table_info("p_session_recording_session_recordings")`,
  );
  if (columns.some((column) => column.name === "username")) return;

  // Adoption leaves older tables unchanged, even after its migration is recorded.
  client.run(
    sql`ALTER TABLE "p_session_recording_session_recordings" ADD COLUMN "username" text`,
  );
  await db.persist();
}
