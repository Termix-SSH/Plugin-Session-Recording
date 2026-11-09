import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, type TestServer } from "./helpers";
import {
  fileHeader,
  newRecordingKey,
  sealFrame,
} from "../../src/backend/crypto";

let server: TestServer | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-recording-pam-"));
});

afterEach(async () => {
  await server?.close();
  server = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

const AUDITOR = [
  "session-recording.view",
  "session-recording.audit",
  "admin.plugins.manage",
];

async function insert(
  owner: string,
  options: { content?: string; sha256?: string | null; hold?: boolean } = {},
): Promise<{ id: number; file: string }> {
  const file = path.join(
    dataDir,
    "session_logs",
    owner,
    `${owner}-${Date.now()}.cast`,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, options.content ?? '{"version":2}\n');
  const result = server!.db.sqlite
    .prepare(
      `INSERT INTO p_session_recording_session_recordings
       (host_id, user_id, username, recording_path, protocol, format, started_at, sha256, hold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      7,
      owner,
      owner,
      file,
      "ssh",
      "asciicast",
      new Date().toISOString(),
      options.sha256 ?? null,
      options.hold ? 1 : 0,
    );
  return {
    id: Number((result as { lastInsertRowid: number }).lastInsertRowid),
    file,
  };
}

describe("auditor access", () => {
  it("only lists everyone's recordings for auditors", async () => {
    server = await startServer({ dataDir });
    await insert("user-1");
    await insert("user-2");
    const denied = await server.request("GET", "/?scope=all");
    expect(denied.status).toBe(403);
    await server.close();

    server = await startServer({ dataDir, permissions: AUDITOR });
    await insert("user-1");
    await insert("user-2");
    const all = await server.request("GET", "/?scope=all");
    expect(all.status).toBe(200);
    expect(
      all.body.logs.map((log: { userId: string }) => log.userId).sort(),
    ).toEqual(["user-1", "user-2"]);
    // No key and no path reach the browser.
    expect(all.body.logs[0].wrappedKey).toBeUndefined();
    expect(all.body.logs[0].recordingPath).toBe("stored");
  });

  it("lets an auditor open someone else's recording and logs it", async () => {
    server = await startServer({ dataDir, permissions: AUDITOR });
    const { id } = await insert("user-1", { content: '[0,"o","hi"]\n' });
    const res = await server.requestBinary(
      "GET",
      `/${id}/content?purpose=download`,
      {
        user: "user-2",
      },
    );
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe('[0,"o","hi"]\n');

    const history = await server.request("GET", `/${id}/access`, {
      user: "user-2",
    });
    expect(history.body.entries).toMatchObject([
      { userId: "user-2", action: "downloaded" },
    ]);
    expect(server.mock.audits).toContainEqual(
      expect.objectContaining({ action: "recording_downloaded" }),
    );
  });

  it("alerts auditors when someone watches another user's recording", async () => {
    server = await startServer({ dataDir, permissions: AUDITOR });
    await server.mock.ctx.settings.set("alertOnAccess", "others");
    const own = await insert("user-2");
    const other = await insert("user-1");
    await server.requestBinary("GET", `/${own.id}/content`, { user: "user-2" });
    expect(server.mock.notifications).toHaveLength(0);
    await server.requestBinary("GET", `/${other.id}/content`, {
      user: "user-2",
    });
    await vi.waitFor(() =>
      expect(
        server!.mock.notifications.map((n) => n.notification),
      ).toContainEqual(
        expect.objectContaining({ category: "session-recording.accessed" }),
      ),
    );
  });

  it("decrypts an encrypted recording on the way out", async () => {
    server = await startServer({ dataDir, permissions: AUDITOR });
    const { id, file } = await insert("user-1");
    const key = newRecordingKey();
    await fs.writeFile(
      file,
      Buffer.concat([fileHeader(), sealFrame(key, Buffer.from("plain text"))]),
    );
    const wrapped = await server.mock.ctx.secrets.seal(key.toString("base64"));
    server.db.sqlite
      .prepare(
        "UPDATE p_session_recording_session_recordings SET wrapped_key = ? WHERE id = ?",
      )
      .run(wrapped, id);
    const res = await server.requestBinary("GET", `/${id}/content`);
    expect(Buffer.from(res.body).toString()).toBe("plain text");
  });
});

describe("verify and hold", () => {
  it("reports ok, then changed after the file is edited", async () => {
    server = await startServer({ dataDir, permissions: AUDITOR });
    const crypto = await import("node:crypto");
    const content = '[0,"o","hi"]\n';
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const { id, file } = await insert("user-1", { content, sha256: sha });
    const ok = await server.request("POST", `/${id}/verify`, { body: {} });
    expect(ok.body.status).toBe("ok");
    await fs.writeFile(file, '[0,"o","edited"]\n');
    const changed = await server.request("POST", `/${id}/verify`, { body: {} });
    expect(changed.body.status).toBe("changed");
    expect(server.mock.notifications.map((n) => n.notification)).toContainEqual(
      expect.objectContaining({
        category: "session-recording.tampered",
        severity: "critical",
      }),
    );
  });

  it("keeps a held recording from delete and retention", async () => {
    server = await startServer({ dataDir, permissions: AUDITOR });
    const { id } = await insert("user-1");
    const held = await server.request("PUT", `/${id}/hold`, {
      body: { hold: true },
    });
    expect(held.body).toEqual({ hold: true });
    const refused = await server.request("DELETE", `/${id}`);
    expect(refused.status).toBe(409);
    await server.request("PUT", `/${id}/hold`, { body: { hold: false } });
    const deleted = await server.request("DELETE", `/${id}`);
    expect(deleted.status).toBe(200);
  });

  it("refuses hold changes without the audit permission", async () => {
    server = await startServer({ dataDir });
    const { id } = await insert("user-1");
    const res = await server.request("PUT", `/${id}/hold`, {
      body: { hold: true },
    });
    expect(res.status).toBe(403);
  });
});

describe("live sessions", () => {
  function sshProvider() {
    const ended: string[] = [];
    return {
      ended,
      provider: {
        getSession: async (id: string) =>
          id === "s-1"
            ? {
                id,
                userId: "user-1",
                hostId: 7,
                hostName: "web",
                isConnected: true,
                createdAt: 1,
              }
            : null,
        listAll: async () => [
          {
            id: "s-1",
            userId: "user-1",
            hostId: 7,
            hostName: "web",
            isConnected: true,
            createdAt: 1,
            recording: true,
          },
        ],
        ownerEndSession: async (id: string) => {
          ended.push(id);
        },
      },
    };
  }

  it("lists and ends sessions for auditors only", async () => {
    const ssh = sshProvider();
    server = await startServer({
      dataDir,
      permissions: AUDITOR,
      services: { "sessions.live#ssh": ssh.provider },
    });
    const list = await server.request("GET", "/live", { user: "user-2" });
    expect(list.body.sessions).toMatchObject([
      { id: "s-1", protocol: "ssh", username: "user-1", recording: true },
    ]);
    const end = await server.request("POST", "/live/ssh/s-1/end", {
      user: "user-2",
      body: { reason: "Policy" },
    });
    expect(end.status).toBe(200);
    expect(ssh.ended).toEqual(["s-1"]);
    expect(server.mock.audits).toContainEqual(
      expect.objectContaining({ action: "session_terminated_by_auditor" }),
    );
  });

  it("refuses the live list without the audit permission", async () => {
    server = await startServer({
      dataDir,
      services: { "sessions.live#ssh": sshProvider().provider },
    });
    expect((await server.request("GET", "/live")).status).toBe(403);
    expect(
      (await server.request("POST", "/live/ssh/s-1/end", { body: {} })).status,
    ).toBe(403);
  });
});

describe("rules", () => {
  it("starts with the starter rules off and saves new ones", async () => {
    server = await startServer({
      dataDir,
      permissions: [...AUDITOR, "session-recording.rules"],
    });
    const start = await server.request("GET", "/rules");
    expect(start.body.rules.length).toBeGreaterThan(5);
    expect(
      start.body.rules.every((rule: { enabled: boolean }) => !rule.enabled),
    ).toBe(true);

    const bad = await server.request("POST", "/rules", {
      body: { name: "x", pattern: "(a+)+", regex: true },
    });
    expect(bad.status).toBe(400);

    const made = await server.request("POST", "/rules", {
      body: { name: "Reboot", pattern: "reboot", target: "input" },
    });
    expect(made.body.rule).toMatchObject({ name: "Reboot", enabled: true });
    const id = made.body.rule.id;
    const changed = await server.request("PUT", `/rules/${id}`, {
      body: { name: "Reboot", pattern: "reboot", action: "end" },
    });
    expect(changed.body.rule.action).toBe("end");
    expect((await server.request("DELETE", `/rules/${id}`)).status).toBe(200);
  });

  it("refuses rules without the rules permission", async () => {
    server = await startServer({ dataDir, permissions: AUDITOR });
    expect((await server.request("GET", "/rules")).status).toBe(403);
  });
});
