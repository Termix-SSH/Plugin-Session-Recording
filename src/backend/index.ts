import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { repairLegacyRecordingSchema } from "./legacy-schema.js";
import {
  recordingAccess,
  recordingRules,
  sessionRecordings,
} from "./tables.js";
import { createSessionRecordingRepository } from "./repository.js";
import { createRecordingsWriter, type RecordingsWriterV1 } from "./service.js";
import { registerSessionRecordingRoutes } from "./routes.js";
import { startRetentionSweep } from "./retention.js";
import { registerOperations } from "./operations.js";
import { createAccessStore, createRuleStore } from "./stores.js";
import { createAccessLog } from "./access.js";
import { createRuleEngine } from "./rule-engine.js";
import { seedStarterRules } from "./seed.js";
import { registerLiveSocket } from "./live-socket.js";

export type { RecordingsWriterV1, RecordingSink } from "./service.js";

export async function activate(ctx: PluginContext) {
  const table = await ctx.db.define(sessionRecordings);
  const accessTable = await ctx.db.define(recordingAccess);
  const rulesTable = await ctx.db.define(recordingRules);
  await repairLegacyRecordingSchema(ctx.db);
  const repository = createSessionRecordingRepository(ctx.db, table, ctx.hosts);
  const rules = createRuleStore(ctx.db, rulesTable);
  const access = createAccessLog(
    ctx,
    createAccessStore(ctx.db, accessTable),
    repository,
  );
  const engine = createRuleEngine(ctx, rules, repository);
  await seedStarterRules(ctx, rules).catch((error) =>
    ctx.log.warn(
      `Could not add the starter rules: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );
  const dataDir = () => ctx.files.dataDir();

  ctx.http.router<Router>().use(
    registerSessionRecordingRoutes({
      ctx,
      repository,
      rules,
      engine,
      access,
      dataDir,
    }),
  );
  registerLiveSocket(ctx, repository, access);

  ctx.services.provide<RecordingsWriterV1>(
    "recordings.writer",
    createRecordingsWriter(ctx, repository, engine),
  );

  // A recording is evidence about the host as much as the person, so it
  // outlives the account: the row's userId is cleared rather than cascading.
  ctx.events.on("user.deleted", (payload) => {
    const { userId } = payload as { userId: string };
    void repository.anonymizeByUserId(userId);
  });

  registerOperations(ctx, repository, dataDir);
  startRetentionSweep(ctx, repository, dataDir);

  ctx.log.info(
    "Session Recording routes mounted at /plugin-api/session-recording",
  );
}

export async function deactivate() {}
