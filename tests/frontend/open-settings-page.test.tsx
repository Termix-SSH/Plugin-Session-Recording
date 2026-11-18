import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const openSingletonTab = vi.fn();
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTabs: () => ({ openSingletonTab }),
  usePluginId: () => "session-recording",
}));

import { useOpenSettingsPage } from "../../src/frontend/SessionLogSettings";

describe("useOpenSettingsPage", () => {
  it("opens this plugin's page in Settings", () => {
    const { result } = renderHook(() => useOpenSettingsPage());
    result.current();
    expect(openSingletonTab).toHaveBeenCalledWith("settings", {
      data: { section: "plugin:session-recording" },
    });
  });
});
