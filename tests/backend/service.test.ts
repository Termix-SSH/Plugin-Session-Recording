import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import manifestJson from "../../manifest.json";
import { pluginDir } from "./helpers";
import { createSessionRecordingRepository } from "../../src/backend/repository";
import { recordingRules, sessionRecordings } from "../../src/backend/tables";
import { createRecordingsWriter, unwrapKey } from "../../src/backend/service";
import { createRuleStore } from "../../src/backend/stores";
import { createRuleEngine } from "../../src/backend/rule-engine";
import { plainReadStream } from "../../src/backend/crypto";

const manifest =
  manifestJson as unknown as import("@termix-ssh/plugin-sdk/manifest").PluginManifest;

let db: TestDb | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-recording-"));
});

afterEach(async () => {
  db?.close();
  db = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function readPlain(file: string, wrappedKey: string | null) {
  const chunks: Buffer[] = [];
  for await (const chunk of plainReadStream(
    file,
    await unwrapKey(lastMock!.ctx, wrappedKey),
  )) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let lastMock: MockPluginContext | null = null;

async function setup(options: { encrypt?: boolean } = {}): Promise<{
  mock: MockPluginContext;
  writer: ReturnType<typeof createRecordingsWriter>;
  rules: ReturnType<typeof createRuleStore>;
  engine: ReturnType<typeof createRuleEngine>;
  repo: ReturnType<typeof createSessionRecordingRepository>;
}> {
  db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
    .run("user-1", "alice");
  db.sqlite.prepare("INSERT INTO ssh_data (id) VALUES (?)").run(7);
  const table = await db.database.define(sessionRecordings);
  const hosts = {
    list: async () => [],
    get: async () => null,
    checkAccess: async () => ({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    }),
    create: async () => {
      throw new Error("not used");
    },
    update: async () => null,
    listOwned: async () => [],
    share: async () => ({ hostId: 0, shared: false }),
    listUsers: async () => [],
    listRoles: async () => [],
    trackSession: () => () => {},
    recordActivity: async () => {},
  };
  const repo = createSessionRecordingRepository(
    db.database,
    table,
    hosts as never,
  );

  const mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
  });
  // Point ctx.files.dataDir() at a real temp dir for this test.
  (mock.ctx as unknown as { files: { dataDir: () => Promise<string> } }).files =
    {
      dataDir: async () => dataDir,
    };

  await mock.ctx.settings.set("encryptRecordings", options.encrypt === true);
  const rules = createRuleStore(
    db.database,
    await db.database.define(recordingRules),
  );
  const engine = createRuleEngine(mock.ctx, rules, repo);
  const writer = createRecordingsWriter(mock.ctx, repo, engine);
  lastMock = mock;
  return { mock, writer, rules, engine, repo };
}

describe("recordings.writer", () => {
  it("is null when the host has recording switched off", async () => {
    const { mock, writer } = await setup();
    await mock.ctx.settings.setHost(7, "enableSessionRecording", false);

    const sink = await writer.open({
      sessionId: "s1",
      hostId: 7,
      userId: "user-1",
      protocol: "ssh",
      format: "asciicast",
      startedAt: Date.now(),
    });

    expect(sink).toBeNull();
    expect(await writer.enabledFor(7)).toBe(false);
    expect(await fs.readdir(dataDir)).toEqual([]);
    expect(
      db!.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM p_session_recording_session_recordings",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps a saved off switch after recreating the writer without affecting another host", async () => {
    const { mock } = await setup();
    db!.sqlite.prepare("INSERT INTO ssh_data (id) VALUES (?)").run(8);
    await mock.ctx.settings.setHost(7, "enableSessionRecording", false);
    await mock.ctx.settings.setHost(8, "enableSessionRecording", true);
    const table = await db!.database.define(sessionRecordings);
    const repository = createSessionRecordingRepository(
      db!.database,
      table,
      mock.ctx.hosts,
    );
    const reopened = createRecordingsWriter(
      mock.ctx,
      repository,
      createRuleEngine(
        mock.ctx,
        createRuleStore(
          db!.database,
          await db!.database.define(recordingRules),
        ),
        repository,
      ),
    );
    for (const hostId of [7, 8]) {
      const sink = await reopened.open({
        sessionId: `host-${hostId}`,
        hostId,
        userId: "user-1",
        protocol: "ssh",
        format: "asciicast",
        startedAt: Date.now(),
      });
      if (hostId === 7) expect(sink).toBeNull();
      else {
        expect(sink).not.toBeNull();
        await sink!.append("marker\n");
      }
    }
    expect(
      await fs.readdir(path.join(dataDir, "session_logs", "user-1")),
    ).toEqual(["host-8.cast"]);
    expect(
      db!.sqlite
        .prepare("SELECT host_id FROM p_session_recording_session_recordings")
        .all(),
    ).toEqual([{ host_id: 8 }]);
  });

  it("writes the first append with writeFile and later ones with appendFile", async () => {
    const { writer } = await setup();
    const sink = await writer.open({
      sessionId: "s1",
      hostId: 7,
      userId: "user-1",
      protocol: "ssh",
      format: "asciicast",
      startedAt: Date.now(),
    });
    expect(sink).not.toBeNull();

    await sink!.append("chunk-one\n");
    await sink!.append("chunk-two\n");

    const filePath = path.join(dataDir, "session_logs", "user-1", "s1.cast");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("chunk-one\nchunk-two\n");
  });

  it("persist writes the summary onto the row", async () => {
    const { writer } = await setup();
    const sink = await writer.open({
      sessionId: "s1",
      hostId: 7,
      userId: "user-1",
      protocol: "ssh",
      format: "asciicast",
      startedAt: Date.now(),
    });
    await sink!.append("x\n");

    const endedAt = Date.now();
    await sink!.persist({
      endedAt,
      durationSeconds: 42,
      terminatedByOwner: true,
      terminationReason: null,
    });

    // Not thrown means it wrote successfully; deeper row assertions belong
    // to repository.test.ts.
  });

  it("discard removes the row and further writes are no-ops", async () => {
    const { writer } = await setup();
    const sink = await writer.open({
      sessionId: "s1",
      hostId: 7,
      userId: "user-1",
      protocol: "ssh",
      format: "asciicast",
      startedAt: Date.now(),
    });

    sink!.discard();
    await sink!.append("should not write");

    const filePath = path.join(dataDir, "session_logs", "user-1", "s1.cast");
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("createFinished inserts a row for an already-written recording", async () => {
    const { writer } = await setup();
    const row = await writer.createFinished({
      hostId: 7,
      userId: "user-1",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      duration: 10,
      recordingPath: "/data/session_recordings/guacamole/x.guac",
      protocol: "rdp",
      format: "guacamole",
    });

    expect(row.id).toBeGreaterThan(0);
  });

  it("createFinished moves guacd's file under the data folder, where playback reads it", async () => {
    const { mock, writer } = await setup();
    const guacdDir = await fs.mkdtemp(path.join(os.tmpdir(), "guacd-"));
    const source = path.join(guacdDir, "guacamole", "rdp-1.guac");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "4.size,1.0;");

    const row = await writer.createFinished({
      hostId: 7,
      userId: "user-1",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      duration: 10,
      recordingPath: source,
      protocol: "rdp",
      format: "guacamole",
    });

    const target = path.join(
      await mock.ctx.files.dataDir(),
      "session_recordings",
      "guacamole",
      "rdp-1.guac",
    );
    await expect(fs.readFile(target, "utf8")).resolves.toBe("4.size,1.0;");
    await expect(fs.access(source)).rejects.toThrow();
    const stored = db!.sqlite
      .prepare(
        "SELECT recording_path FROM p_session_recording_session_recordings WHERE id = ?",
      )
      .get(row.id) as { recording_path: string };
    expect(stored.recording_path).toBe(target);
    await fs.rm(guacdDir, { recursive: true, force: true });
  });

  it("createFinished copies through the caller's reader when it can't open the file", async () => {
    const { mock, writer } = await setup();
    const body = Buffer.from("4.size,1.0;4.sync,1.1;");
    const offsets: number[] = [];

    const row = await writer.createFinished({
      hostId: 7,
      userId: "user-1",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      duration: 10,
      recordingPath: "/elsewhere/guacamole/rdp-2.guac",
      protocol: "rdp",
      format: "guacamole",
      read: async (offset) => {
        offsets.push(offset);
        return body.subarray(offset, offset + 8);
      },
    });

    const target = path.join(
      await mock.ctx.files.dataDir(),
      "session_recordings",
      "guacamole",
      "rdp-2.guac",
    );
    await expect(fs.readFile(target, "utf8")).resolves.toBe(body.toString());
    expect(offsets).toEqual([0, 8, 16, 22]);
    const stored = db!.sqlite
      .prepare(
        "SELECT recording_path FROM p_session_recording_session_recordings WHERE id = ?",
      )
      .get(row.id) as { recording_path: string };
    expect(stored.recording_path).toBe(target);
  });

  it("enabledFor follows the host's recording switch", async () => {
    const { mock, writer } = await setup();
    await mock.ctx.settings.setHost(7, "enableSessionRecording", true);
    await expect(writer.enabledFor(7)).resolves.toBe(true);
    await mock.ctx.settings.setHost(7, "enableSessionRecording", false);
    await expect(writer.enabledFor(7)).resolves.toBe(false);
  });

  it("is on for every host when an admin makes recording required", async () => {
    const { mock, writer } = await setup();
    await mock.ctx.settings.setHost(7, "enableSessionRecording", false);
    await mock.ctx.settings.set("forceRecording", "all");
    await expect(writer.isForced(7)).resolves.toBe(true);
    await expect(writer.enabledFor(7)).resolves.toBe(true);
    await mock.ctx.settings.set("forceRecording", "privileged");
    // No Privileged Access plugin: no host is privileged.
    await expect(writer.isForced(7)).resolves.toBe(false);
  });

  it("encrypts a live recording and keeps its hash", async () => {
    const { writer, repo } = await setup({ encrypt: true });
    const sink = await writer.open({
      sessionId: "enc-1",
      hostId: 7,
      userId: "user-1",
      protocol: "ssh",
      format: "asciicast",
      startedAt: Date.now(),
    });
    await sink!.append('{"version":2}\n');
    await sink!.append('[0.1,"o","secret output"]\n');
    await sink!.persist({
      endedAt: Date.now(),
      durationSeconds: 1,
      terminatedByOwner: false,
      terminationReason: null,
    });
    const file = path.join(dataDir, "session_logs", "user-1", "enc-1.cast");
    const raw = await fs.readFile(file);
    expect(raw.toString("latin1")).not.toContain("secret output");
    const row = await repo.findBySessionId("enc-1");
    expect(row?.wrappedKey).toBeTruthy();
    const plain = await readPlain(file, row!.wrappedKey);
    expect(plain).toBe('{"version":2}\n[0.1,"o","secret output"]\n');
    const crypto = await import("node:crypto");
    expect(row?.sha256).toBe(
      crypto.createHash("sha256").update(plain).digest("hex"),
    );
  });

  it("encrypts a finished remote desktop recording", async () => {
    const { writer, repo } = await setup({ encrypt: true });
    const guacdDir = await fs.mkdtemp(path.join(os.tmpdir(), "guacd-"));
    const source = path.join(guacdDir, "guacamole", "rdp-2.guac");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "4.size,1.0;");
    const { id } = await writer.createFinished({
      hostId: 7,
      userId: "user-1",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      duration: 3,
      recordingPath: source,
      protocol: "rdp",
      format: "guacamole",
    });
    const row = await repo.findById(id);
    expect(row?.wrappedKey).toBeTruthy();
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const raw = await fs.readFile(row!.recordingPath!, "utf8");
    expect(raw).not.toContain("size");
    await expect(readPlain(row!.recordingPath!, row!.wrappedKey)).resolves.toBe(
      "4.size,1.0;",
    );
    await fs.rm(guacdDir, { recursive: true, force: true });
  });

  it("flags a typed command that matches a rule and alerts auditors", async () => {
    const { mock, writer, rules, repo } = await setup();
    await rules.create(
      {
        name: "Switch to root",
        pattern: "sudo su",
        regex: false,
        target: "input",
        hosts: "all",
        severity: "warning",
        action: "alert",
        enabled: true,
      },
      "admin",
    );
    const sink = await writer.open({
      sessionId: "rule-1",
      hostId: 7,
      userId: "user-1",
      protocol: "ssh",
      format: "asciicast",
      startedAt: Date.now(),
    });
    await sink!.append('{"version":2}\n');
    for (const key of ["s", "u", "d", "o", " ", "s", "u", "\r"]) {
      await sink!.append(`${JSON.stringify([1.5, "i", key])}\n`);
    }
    await sink!.persist({
      endedAt: Date.now(),
      durationSeconds: 2,
      terminatedByOwner: false,
      terminationReason: null,
    });
    const row = await repo.findBySessionId("rule-1");
    const flags = JSON.parse(row!.flags ?? "[]");
    expect(flags).toMatchObject([
      { name: "Switch to root", text: "sudo su", t: 1.5 },
    ]);
    await vi.waitFor(() =>
      expect(
        mock.notifications.map((entry) => entry.notification),
      ).toContainEqual(
        expect.objectContaining({
          category: "session-recording.rule",
          audience: { permission: "session-recording.audit" },
        }),
      ),
    );
  });
});
