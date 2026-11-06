import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";

export interface RecordingFlag {
  t: number;
  ruleId: number;
  name: string;
  severity: "info" | "warning" | "critical";
  action: "alert" | "end";
  text: string;
}

export type SessionLogRecord = {
  id: number;
  hostId: number;
  userId: string | null;
  startedAt: string;
  endedAt: string | null;
  duration: number | null;
  recordingPath: string | null;
  hostName: string | null;
  hostIp: string | null;
  sizeBytes: number | null;
  protocol: "ssh" | "rdp" | "vnc" | "telnet";
  format: "text" | "asciicast" | "guacamole";
  username: string | null;
  encrypted?: boolean;
  hold?: boolean;
  flags?: RecordingFlag[];
  terminationReason?: string | null;
};

export interface AccessEntry {
  id: number;
  userId: string | null;
  username: string | null;
  action: string;
  at: string;
  ip: string | null;
}

export interface LiveSession {
  id: string;
  protocol: "ssh" | "rdp" | "vnc" | "ard" | "telnet";
  userId: string;
  username: string | null;
  hostId: number;
  hostName: string;
  isConnected: boolean;
  createdAt: number;
  recording: boolean;
}

export interface RecordingRule {
  id: number;
  name: string;
  pattern: string;
  regex: boolean;
  target: "input" | "output";
  hosts: "all" | "privileged";
  severity: "info" | "warning" | "critical";
  action: "alert" | "end";
  enabled: boolean;
}

export type VerifyStatus = "ok" | "changed" | "unknown" | "missing";

export function createSessionRecordingApi(api: PluginApiClient) {
  return {
    async list(scope: "mine" | "all" = "mine"): Promise<SessionLogRecord[]> {
      const response = await api.get<{ logs: SessionLogRecord[] }>(
        scope === "all" ? "/?scope=all" : "/",
      );
      return response.data.logs;
    },

    async getBlob(
      id: number,
      purpose: "view" | "download" = "view",
    ): Promise<Blob> {
      const response = await api.get<Blob>(
        `/${id}/content?purpose=${purpose}`,
        { responseType: "blob" },
      );
      return response.data;
    },

    async getContent(id: number): Promise<string> {
      const response = await api.get<string>(`/${id}/content?purpose=view`, {
        responseType: "text",
      });
      return response.data;
    },

    async delete(id: number): Promise<void> {
      await api.delete(`/${id}`);
    },

    async access(id: number): Promise<AccessEntry[]> {
      const response = await api.get<{ entries: AccessEntry[] }>(
        `/${id}/access`,
      );
      return response.data.entries;
    },

    async verify(id: number): Promise<VerifyStatus> {
      const response = await api.post<{ status: VerifyStatus }>(
        `/${id}/verify`,
        {},
      );
      return response.data.status;
    },

    async setHold(id: number, hold: boolean): Promise<void> {
      await api.put(`/${id}/hold`, { hold });
    },

    async live(): Promise<LiveSession[]> {
      const response = await api.get<{ sessions: LiveSession[] }>("/live");
      return response.data.sessions;
    },

    async endLive(session: LiveSession, reason?: string): Promise<void> {
      await api.post(
        `/live/${session.protocol}/${encodeURIComponent(session.id)}/end`,
        { reason },
      );
    },

    async viewerToken(session: LiveSession): Promise<string> {
      const response = await api.post<{ token: string }>(
        `/live/${session.protocol}/${encodeURIComponent(session.id)}/viewer`,
        {},
      );
      return response.data.token;
    },

    async rules(): Promise<RecordingRule[]> {
      const response = await api.get<{ rules: RecordingRule[] }>("/rules");
      return response.data.rules;
    },

    async saveRule(
      rule: Omit<RecordingRule, "id"> & { id?: number },
    ): Promise<RecordingRule> {
      const { id, ...body } = rule;
      const response = id
        ? await api.put<{ rule: RecordingRule }>(`/rules/${id}`, body)
        : await api.post<{ rule: RecordingRule }>("/rules", body);
      return response.data.rule;
    },

    async deleteRule(id: number): Promise<void> {
      await api.delete(`/rules/${id}`);
    },
  };
}

export type SessionRecordingApi = ReturnType<typeof createSessionRecordingApi>;
