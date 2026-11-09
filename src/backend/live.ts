import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * Live sessions of every user, read through sessions.live. SSH Terminal
 * provides "ssh" and Remote Desktop the other types. Each provider checks
 * its own monitor permission, so an auditor also needs ssh-terminal.monitor
 * and remote-desktop.monitor.
 */
export const LIVE_PROVIDERS = ["ssh", "rdp", "vnc", "ard", "telnet"] as const;
export type LiveProtocol = (typeof LIVE_PROVIDERS)[number];

export interface LiveSession {
  id: string;
  protocol: LiveProtocol;
  userId: string;
  hostId: number;
  hostName: string;
  isConnected: boolean;
  createdAt: number;
  recording: boolean;
}

interface LiveProvider {
  listAll?: () => Promise<LiveSessionRow[]> | LiveSessionRow[];
  getSession?: (id: string) => Promise<LiveSessionRow | null>;
  ownerEndSession?: (id: string, reason: string) => Promise<void> | void;
  subscribe?: (
    id: string,
    onData: (data: string) => void,
  ) => Promise<() => void> | (() => void);
  snapshot?: (id: string) => Promise<string | null>;
  createViewerToken?: (
    id: string,
    readOnly: boolean,
  ) => Promise<string> | string;
}

interface LiveSessionRow {
  id: string;
  userId: string;
  hostId: number;
  hostName: string;
  isConnected: boolean;
  createdAt: number;
  recording?: boolean;
}

export function isLiveProtocol(value: unknown): value is LiveProtocol {
  return (LIVE_PROVIDERS as readonly unknown[]).includes(value);
}

function provider(
  ctx: PluginContext,
  protocol: LiveProtocol,
): LiveProvider | null {
  try {
    if (!ctx.services.providers("sessions.live").includes(protocol)) {
      return null;
    }
    return ctx.services.get<LiveProvider>("sessions.live", {
      provider: protocol,
    });
  } catch {
    return null;
  }
}

/** Every live session the acting user may monitor. */
export async function listLive(ctx: PluginContext): Promise<LiveSession[]> {
  const all: LiveSession[] = [];
  for (const protocol of LIVE_PROVIDERS) {
    const live = provider(ctx, protocol);
    if (!live?.listAll) continue;
    try {
      for (const row of await live.listAll()) {
        all.push({
          id: row.id,
          protocol,
          userId: row.userId,
          hostId: row.hostId,
          hostName: row.hostName,
          isConnected: row.isConnected,
          createdAt: row.createdAt,
          recording: row.recording === true,
        });
      }
    } catch {
      // A provider that refuses (no monitor permission) lists nothing.
    }
  }
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getLive(
  ctx: PluginContext,
  protocol: LiveProtocol,
  id: string,
): Promise<LiveSessionRow | null> {
  const live = provider(ctx, protocol);
  if (!live?.getSession) return null;
  return (await live.getSession(id)) ?? null;
}

export async function endLiveSession(
  ctx: PluginContext,
  protocol: LiveProtocol,
  id: string,
  reason: string,
): Promise<boolean> {
  const live = provider(ctx, protocol);
  if (!live?.ownerEndSession) return false;
  await live.ownerEndSession(id, reason);
  return true;
}

/** Streams an SSH session's output. Resolves to the unsubscribe. */
export async function watchSsh(
  ctx: PluginContext,
  id: string,
  onData: (data: string) => void,
): Promise<{ snapshot: string | null; stop: () => void } | null> {
  const live = provider(ctx, "ssh");
  if (!live?.subscribe) return null;
  const snapshot = live.snapshot ? await live.snapshot(id) : null;
  const stop = await live.subscribe(id, onData);
  return { snapshot, stop };
}

/** A read only viewer token for a remote desktop session. */
export async function viewerToken(
  ctx: PluginContext,
  protocol: LiveProtocol,
  id: string,
): Promise<string | null> {
  const live = provider(ctx, protocol);
  if (!live?.createViewerToken) return null;
  return live.createViewerToken(id, true);
}
