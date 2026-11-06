import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { SessionRecordingRepository } from "./repository.js";
import type { RuleStore } from "./stores.js";
import { RecordingScanner, type Rule, type RuleMatch } from "./rules.js";
import { AUDIT_PERMISSION, isPrivileged } from "./policy.js";
import { endLiveSession } from "./live.js";

const MAX_FLAGS = 200;
const ALERT_GAP_MS = 10 * 60 * 1000;

export interface ScanTarget {
  recordingId: number;
  sessionId: string;
  hostId: number;
  userId: string;
  username: string | null;
}

export interface RecordingRuleScanner {
  scan: (chunk: string) => void;
  /** The matches so far as JSON, or null when there are none. */
  flagsJson: () => string | null;
}

export type RuleEngine = ReturnType<typeof createRuleEngine>;

/** Keeps the enabled rules in memory and acts on matches. */
export function createRuleEngine(
  ctx: PluginContext,
  store: RuleStore,
  repository: SessionRecordingRepository,
) {
  let cached: Rule[] | null = null;
  const lastAlert = new Map<string, number>();

  async function rules(): Promise<Rule[]> {
    if (!cached) cached = (await store.list()).filter((rule) => rule.enabled);
    return cached;
  }

  async function hostName(hostId: number): Promise<string> {
    const host = await ctx.hosts.get(hostId).catch(() => null);
    return host?.name || host?.ip || `#${hostId}`;
  }

  async function act(target: ScanTarget, match: RuleMatch): Promise<void> {
    const key = `${target.sessionId}:${match.ruleId}`;
    const now = Date.now();
    const last = lastAlert.get(key) ?? 0;
    const ending = match.action === "end";
    if (!ending && now - last < ALERT_GAP_MS) return;
    lastAlert.set(key, now);
    if (lastAlert.size > 5000) lastAlert.clear();

    const name = await hostName(target.hostId);
    const who = target.username ?? target.userId;
    await ctx.notify
      .send({
        title: `${match.name}: ${who} on ${name}`,
        body: match.text,
        severity: match.severity,
        category: "session-recording.rule",
        audience: { permission: AUDIT_PERMISSION },
        link: { tab: "session-logs" },
        context: {
          hostId: target.hostId,
          hostName: name,
          sourceId: String(match.ruleId),
          sourceName: match.name,
          triggerType: "session-recording.rule",
        },
      })
      .catch(() => {});
    await ctx.audit
      .record({
        action: "session_rule_matched",
        resourceType: "session_recording",
        resourceId: String(target.recordingId),
        resourceName: match.name,
        details: `${who} on ${name}: ${match.text}`,
        success: true,
      })
      .catch(() => {});
    await ctx.operations
      ?.emit(
        "session-recording.alert",
        {
          recordingId: target.recordingId,
          ruleId: match.ruleId,
          rule: match.name,
          severity: match.severity,
          action: match.action,
          userId: target.userId,
          text: match.text,
        },
        { hostId: target.hostId },
      )
      .catch(() => {});
    if (ending) {
      await endLiveSession(
        ctx,
        "ssh",
        target.sessionId,
        `Ended by rule: ${match.name}`,
      ).catch(() => {});
    }
  }

  return {
    /** Forget the cached rules after an edit. */
    reload(): void {
      cached = null;
    },

    async scannerFor(target: ScanTarget): Promise<RecordingRuleScanner | null> {
      const active = await rules().catch(() => []);
      if (active.length === 0) return null;
      const privileged = active.some((rule) => rule.hosts === "privileged")
        ? await isPrivileged(ctx, target.hostId)
        : false;
      const applies = active.filter(
        (rule) => rule.hosts === "all" || privileged,
      );
      const scanner = new RecordingScanner(applies);
      if (scanner.empty) return null;
      const flags: RuleMatch[] = [];
      let saving = false;

      const save = () => {
        if (saving) return;
        saving = true;
        // Matches are rare; write them soon so a crash keeps them.
        setTimeout(() => {
          saving = false;
          void repository
            .setFlags(target.recordingId, JSON.stringify(flags))
            .catch(() => {});
        }, 2000).unref?.();
      };

      return {
        scan(chunk) {
          let found: RuleMatch[];
          try {
            found = scanner.scan(chunk);
          } catch {
            return;
          }
          for (const match of found) {
            if (flags.length < MAX_FLAGS) flags.push(match);
            void act(target, match);
          }
          if (found.length) save();
        },
        flagsJson: () => (flags.length ? JSON.stringify(flags) : null),
      };
    },
  };
}
