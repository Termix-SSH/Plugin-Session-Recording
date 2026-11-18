import { describe, expect, it } from "vitest";
import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { registerSessionRecordingRoutes } from "../../src/backend/routes.js";

// A plugin process only serves routes added to ctx's router itself.
function recordingRouter() {
  const added: string[] = [];
  const record = (method: string) => (path: unknown) => {
    if (typeof path !== "string") throw new Error(`${method} without a path`);
    added.push(`${method.toUpperCase()} ${path}`);
  };
  const router = {
    get: record("get"),
    post: record("post"),
    put: record("put"),
    patch: record("patch"),
    delete: record("delete"),
    use: (handler: unknown) => {
      if (typeof handler === "function" && "stack" in handler) {
        throw new Error(
          "a mounted sub-router hides routes from a plugin process",
        );
      }
    },
  };
  return { router: router as unknown as Router, added };
}

describe("route mounting", () => {
  it("adds every route to ctx's router", () => {
    const { router, added } = recordingRouter();
    const ctx = {
      rbac: { require: () => () => undefined, has: () => false },
      currentActor: () => null,
    } as unknown as PluginContext;
    registerSessionRecordingRoutes({
      router,
      ctx,
      repository: {} as never,
      rules: {} as never,
      engine: {} as never,
      access: {} as never,
      dataDir: async () => "/data",
    });
    expect(added.some((r) => r.startsWith("GET "))).toBe(true);
    expect(added.length).toBeGreaterThan(3);
  });
});
