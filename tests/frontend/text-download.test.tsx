import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

let rendered: RenderedPluginApp | undefined;
afterEach(async () => {
  cleanup();
  await rendered?.deactivate();
  rendered = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const log = {
  id: 1,
  hostId: 7,
  hostName: "web",
  userId: "user-1",
  protocol: "ssh",
  format: "asciicast",
  startedAt: "2026-11-06T12:00:00.123Z",
};

async function download(
  includeOutputTimestamps: boolean,
  format = "asciicast",
) {
  let saved: NodeBlob | undefined;
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL(blob: Blob | MediaSource) {
        saved = blob as unknown as NodeBlob;
        return "blob:test";
      }
      static revokeObjectURL() {}
    },
  );
  vi.stubGlobal("Blob", NodeBlob);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const source =
    format === "text"
      ? "legacy text\n"
      : '{"version":2,"timestamp":1793966400}\n[0.125,"o","\\u001b[31mhello\\u001b[0m\\r\\n"]';
  const get = vi.fn(async (path: string) => ({
    data:
      path === "/"
        ? { logs: [{ ...log, format }] }
        : path === "/1"
          ? { log: { ...log, format, includeOutputTimestamps } }
          : new NodeBlob([source]),
  }));
  rendered = await renderWithApp(plugin, {
    manifest: manifestJson as unknown as PluginManifest,
    locales,
    permissions: ["session-recording.view"],
    api: { get } as unknown as PluginApiClient,
  });
  rendered.renderPanel("session-logs");
  await screen.findByText("web");
  // Legacy text logs only offer their unchanged original download.
  fireEvent.click(
    screen.getByLabelText(format === "text" ? "Download" : "Download as text"),
  );
  await waitFor(() => expect(saved).toBeDefined());
  return { text: await saved!.text(), get };
}

describe("text download wiring", () => {
  it("reads the current host option and exports timed output events", async () => {
    const { text, get } = await download(true);
    expect(text).toBe(
      '[2026-11-06T12:00:00.248Z] "\\u001b[31mhello\\u001b[0m\\r\\n"',
    );
    expect(get).toHaveBeenCalledWith("/1");
    expect(get).toHaveBeenCalledWith("/1/content?purpose=download", {
      responseType: "blob",
    });
  });

  it("keeps the ordinary rendered text when the host option is off", async () => {
    const { text } = await download(false);
    expect(text).toBe("hello");
  });

  it("does not invent event timing for legacy plain text", async () => {
    const { text, get } = await download(true, "text");
    expect(text).toBe("legacy text\n");
    expect(get).not.toHaveBeenCalledWith("/1");
  });
});
