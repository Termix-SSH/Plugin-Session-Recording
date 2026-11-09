import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

export type ForceMode = "off" | "privileged" | "all";
export type AccessAlertMode = "off" | "others" | "all";

/** What Privileged Access offers other plugins about its hosts. */
export interface PrivilegedHostsV1 {
  isPrivileged: (hostId: number) => Promise<boolean>;
}

export const AUDIT_PERMISSION = "session-recording.audit";

export async function forceMode(ctx: PluginContext): Promise<ForceMode> {
  const value = await ctx.settings.get<string>("forceRecording");
  return value === "privileged" || value === "all" ? value : "off";
}

export async function encryptionOn(ctx: PluginContext): Promise<boolean> {
  return (await ctx.settings.get<boolean>("encryptRecordings")) !== false;
}

export async function accessAlertMode(
  ctx: PluginContext,
): Promise<AccessAlertMode> {
  const value = await ctx.settings.get<string>("alertOnAccess");
  return value === "others" || value === "all" ? value : "off";
}

/** Whether Privileged Access marks a host as privileged. False without it. */
export async function isPrivileged(
  ctx: PluginContext,
  hostId: number,
): Promise<boolean> {
  try {
    if (!ctx.services.providers("privileged-access.hosts").includes("")) {
      return false;
    }
    const service = ctx.services.get<PrivilegedHostsV1>(
      "privileged-access.hosts",
    );
    return (await service.isPrivileged(hostId)) === true;
  } catch {
    return false;
  }
}

/** Whether an admin made recording required for this host. */
export async function isForced(
  ctx: PluginContext,
  hostId: number,
): Promise<boolean> {
  const mode = await forceMode(ctx);
  if (mode === "all") return true;
  if (mode === "privileged") return isPrivileged(ctx, hostId);
  return false;
}
