import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const LOG = {
  id: 1,
  hostId: 7,
  hostName: "web",
  userId: "user-2",
  username: "bob",
  protocol: "ssh",
  format: "asciicast",
  startedAt: "2026-10-01T10:00:00.000Z",
  duration: 5,
  sizeBytes: 10,
  hold: true,
  flags: [
    {
      t: 1,
      ruleId: 1,
      name: "Root",
      severity: "warning",
      action: "alert",
      text: "sudo su",
    },
  ],
};

const LIVE = {
  id: "s-1",
  protocol: "ssh",
  userId: "user-2",
  username: "bob",
  hostId: 7,
  hostName: "db",
  isConnected: true,
  createdAt: Date.parse("2026-10-01T10:00:00.000Z"),
  recording: true,
};

function api(): PluginApiClient {
  return {
    get: vi.fn(async (url: string) => {
      if (url === "/live") return { data: { sessions: [LIVE] } };
      if (url === "/rules") {
        return {
          data: {
            rules: [
              {
                id: 3,
                name: "Switch to root",
                pattern: "sudo su",
                regex: false,
                target: "input",
                hosts: "all",
                severity: "warning",
                action: "end",
                enabled: false,
              },
            ],
          },
        };
      }
      return { data: { logs: [LOG] } };
    }),
    post: vi.fn(async () => ({ data: { success: true } })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
  } as unknown as PluginApiClient;
}

describe("audit views", () => {
  it("shows only the user's own list without audit permissions", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["session-recording.view"],
      api: api(),
    });
    rendered.renderPanel("session-logs");
    expect(await screen.findByText("web")).toBeTruthy();
    expect(screen.queryByText("All users")).toBeNull();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("marks held and flagged recordings and lists everyone's for auditors", async () => {
    const client = api();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["session-recording.view", "session-recording.audit"],
      api: client,
    });
    rendered.renderPanel("session-logs");
    fireEvent.click(await screen.findByText("All users"));
    expect(await screen.findByText("On hold")).toBeTruthy();
    expect(screen.getByText("1 alerts")).toBeTruthy();
    expect(client.get).toHaveBeenCalledWith("/?scope=all");
  });

  it("lists live sessions and ends one after a confirm", async () => {
    const client = api();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["session-recording.view", "session-recording.audit"],
      api: client,
    });
    rendered.renderPanel("session-logs");
    fireEvent.click(await screen.findByText("Live"));
    expect(await screen.findByText("db")).toBeTruthy();
    expect(screen.getByText("Recording")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("End session"));
    const confirm = await screen.findAllByText("End session");
    fireEvent.click(confirm[confirm.length - 1]);
    await vi.waitFor(() =>
      expect(client.post).toHaveBeenCalledWith("/live/ssh/s-1/end", {
        reason: "Ended by an auditor",
      }),
    );
  });

  it("shows the rules tab with the rules permission", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["session-recording.view", "session-recording.rules"],
      api: api(),
    });
    rendered.renderPanel("session-logs");
    fireEvent.click(await screen.findByText("Rules"));
    expect(await screen.findByText("Switch to root")).toBeTruthy();
    expect(screen.getByText("Alert and end the session")).toBeTruthy();
  });
});
