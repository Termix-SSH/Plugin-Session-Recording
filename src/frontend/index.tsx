import { ScrollText } from "lucide-react";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { SessionLogsPanel } from "./SessionLogsPanel";

export function activate(app: TermixApp): void {
  app.registerRailItem({
    id: "session-logs",
    icon: ScrollText,
    titleKey: "nav.sessionLogs",
    kind: "panel",
    promotable: true,
    rightDockable: true,
    separatorAfter: true,
    permission: "view",
  });

  app.registerPanel("session-logs", () => <SessionLogsPanel />);

  app.registerTab("session-logs", () => <SessionLogsPanel />, {
    icon: ScrollText,
    titleKey: "nav.sessionLogs",
    hostless: true,
  });
}

export function deactivate(): void {}
