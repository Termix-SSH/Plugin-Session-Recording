import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import { registerOperations } from "../../src/backend/operations.js";
import type { SessionRecordingRepository } from "../../src/backend/repository.js";

type Handler = {
  run: (input: unknown, context: PluginOperationContext) => Promise<unknown>;
};

function setup(rows: unknown[]) {
  const handlers = new Map<string, Handler>();
  const ctx = {
    currentActor: () => "user-1",
    operations: {
      register: (id: string, handler: Handler) => handlers.set(id, handler),
    },
  } as unknown as PluginContext;
  const repository = {
    listByUserIdWithHost: async () => rows,
  } as unknown as SessionRecordingRepository;
  registerOperations(ctx, repository, async () => os.tmpdir());
  return handlers;
}

describe("session-recording.usage", () => {
  it("sums recording sizes for one host", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
    const file = path.join(dir, "a.cast");
    fs.writeFileSync(file, "x".repeat(2048));
    const handlers = setup([
      { id: 1, hostId: 7, recordingPath: file },
      { id: 2, hostId: 7, recordingPath: path.join(dir, "gone.cast") },
      { id: 3, hostId: 8, recordingPath: file },
    ]);
    const result = (await handlers
      .get("session-recording.usage")!
      .run({}, { hostId: 7 } as PluginOperationContext)) as {
      data: { value: number; status: string; label: string };
    };
    expect(result.data.value).toBe(2048);
    expect(result.data.status).toBe("ok");
    expect(result.data.label).toContain("2 recordings");
  });

  it("needs a host", async () => {
    const handlers = setup([]);
    await expect(
      handlers
        .get("session-recording.usage")!
        .run({}, {} as PluginOperationContext),
    ).rejects.toThrow("needs a host");
  });
});
