import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { RuleStore } from "./stores.js";
import { STARTER_RULES } from "./rules.js";

const SEEDED_KEY = "rules:seeded";

/** Adds the starter rules once, all off, so an admin only has to turn them on. */
export async function seedStarterRules(
  ctx: PluginContext,
  rules: RuleStore,
): Promise<void> {
  if (await ctx.kv.get(SEEDED_KEY)) return;
  if ((await rules.list()).length === 0) {
    for (const rule of STARTER_RULES) {
      await rules.create({ ...rule, enabled: false }, null);
    }
  }
  await ctx.kv.set(SEEDED_KEY, true);
}
