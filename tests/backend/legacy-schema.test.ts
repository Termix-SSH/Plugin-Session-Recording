import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@termix-ssh/plugin-sdk/testing";
import { pluginDir } from "./helpers";
import { repairLegacyRecordingSchema } from "../../src/backend/legacy-schema";

let db: TestDb | null = null;
afterEach(() => db?.close());

const table = "p_session_recording_session_recordings";

describe("legacy recording schema repair", () => {
  it.each([false, true])(
    "repairs a legacy table (already adopted: %s) and preserves recordings",
    async (adopted) => {
      db = await createTestDb(pluginDir, { skipMigrations: true });
      const migration = fs.readFileSync(
        path.join(
          pluginDir,
          "migrations/sqlite/0001_adopt_session_recordings.sql",
        ),
        "utf8",
      );
      db.sqlite.exec(migration.replace(/ {2}"username" text,\r?\n/, ""));
      if (adopted) {
        db.applied.push("0001_adopt_session_recordings");
      } else {
        db.sqlite.exec(`ALTER TABLE ${table} RENAME TO session_recordings`);
      }
      db.sqlite.exec("INSERT INTO ssh_data (id) VALUES (7)");
      db.sqlite.exec(
        `INSERT INTO ${adopted ? table : "session_recordings"} (host_id, recording_path) VALUES (7, '/data/old.cast')`,
      );

      await db.migrate();
      await repairLegacyRecordingSchema(db.database);
      await repairLegacyRecordingSchema(db.database);

      expect(
        db.sqlite
          .prepare(`SELECT id, recording_path, username FROM ${table}`)
          .all(),
      ).toEqual([{ id: 1, recording_path: "/data/old.cast", username: null }]);
      db.sqlite
        .prepare(
          `INSERT INTO ${table} (host_id, username, recording_path) VALUES (?, ?, ?)`,
        )
        .run(7, "alice", "/data/new.cast");
      expect(
        db.sqlite.prepare(`SELECT username FROM ${table} WHERE id = 2`).get(),
      ).toEqual({ username: "alice" });
      expect(db.persisted).toBe(1);
    },
  );

  it("keeps existing usernames without rewriting a current database", async () => {
    db = await createTestDb(pluginDir);
    db.sqlite.exec("INSERT INTO ssh_data (id) VALUES (7)");
    db.sqlite.exec(
      `INSERT INTO ${table} (host_id, username) VALUES (7, 'alice')`,
    );
    await repairLegacyRecordingSchema(db.database);
    expect(db.sqlite.prepare(`SELECT username FROM ${table}`).get()).toEqual({
      username: "alice",
    });
    expect(db.persisted).toBe(0);
  });
});
