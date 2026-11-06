import {
  adoptLegacyTable,
  boolean,
  defineTable,
  id,
  integer,
  refHost,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

/**
 * userId is a plain column, not refUser(): a recording is evidence about the
 * host as much as the person, so it outlives the account. The plugin listens
 * for user.deleted and clears userId itself instead of cascading. username
 * keeps an anonymized row attributable.
 */
export const sessionRecordings = adoptLegacyTable(
  "session_recordings",
  defineTable(
    "session_recordings",
    {
      id: id(),
      hostId: refHost(),
      userId: varchar(),
      username: text(),
      accessId: integer(),
      startedAt: timestamp().notNull().defaultNow(),
      endedAt: timestamp(),
      duration: integer(),
      commands: text(),
      dangerousActions: text(),
      recordingPath: text(),
      protocol: text().notNull().default("ssh"),
      format: text().notNull().default("text"),
      terminatedByOwner: boolean().default(false),
      terminationReason: text(),
      // Sealed per recording key; null for an unencrypted file.
      wrappedKey: text(),
      // SHA-256 of the plain recording, written when it ends.
      sha256: text(),
      hold: boolean().notNull().default(false),
      // Rule matches as JSON: [{ t, ruleId, name, text }].
      flags: text(),
    },
    {
      indexes: [
        {
          name: "idx_session_recordings_user_started",
          columns: ["userId", "startedAt"],
        },
        { name: "idx_session_recordings_host", columns: ["hostId"] },
      ],
    },
  ),
);

/** Who watched, downloaded or checked a recording, and when. */
export const recordingAccess = defineTable(
  "access",
  {
    id: id(),
    recordingId: integer().notNull(),
    userId: varchar(),
    username: text(),
    action: text().notNull(),
    at: timestamp().notNull().defaultNow(),
    ip: text(),
  },
  {
    indexes: [
      { name: "idx_session_recording_access_rec", columns: ["recordingId"] },
    ],
  },
);

/** Admin rules matched against what is typed or printed in SSH sessions. */
export const recordingRules = defineTable("rules", {
  id: id(),
  name: text().notNull(),
  pattern: text().notNull(),
  regex: boolean().notNull().default(false),
  target: text().notNull().default("input"),
  hosts: text().notNull().default("all"),
  severity: text().notNull().default("warning"),
  action: text().notNull().default("alert"),
  enabled: boolean().notNull().default(true),
  createdBy: varchar(),
  createdAt: timestamp().notNull().defaultNow(),
});

export const tables = [sessionRecordings, recordingAccess, recordingRules];
