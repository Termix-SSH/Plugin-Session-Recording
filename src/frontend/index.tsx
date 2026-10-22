import { ScrollText } from "lucide-react";
import type { TabProps, TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { SessionLogsPanel } from "./SessionLogsPanel";
import { RecordingsCard } from "./RecordingsCard";

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

  app.registerTab(
    "session-logs",
    ({ tab }: TabProps) => (
      <SessionLogsPanel
        initialLogId={
          typeof tab.data?.logId === "number" ? tab.data.logId : undefined
        }
      />
    ),
    {
      icon: ScrollText,
      titleKey: "nav.sessionLogs",
      hostless: true,
    },
  );

  app.registerDashboardCard({
    id: "session-recordings",
    titleKey: "card.title",
    defaultPanel: "side",
    defaultHeight: 220,
    frame: "framed",
    component: RecordingsCard,
  });
}

export function deactivate(): void {}
