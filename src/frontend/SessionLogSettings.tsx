import {
  useTranslation,
  type SettingsState,
} from "@termix-ssh/plugin-sdk/frontend";
import type { ReactNode } from "react";
import { Rows3, SlidersHorizontal } from "lucide-react";
import {
  FakeSwitch,
  InlineView,
  SectionCard,
  SettingRow,
} from "@termix-ssh/plugin-sdk/ui";

// Buttons go under the row when always shown, otherwise in the hover tray.
export function rowActionProps(always: boolean, actions: ReactNode) {
  return always
    ? {
        children: (
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex flex-wrap items-center gap-[1.75px] border-t border-border/30 pt-[3.5px]"
          >
            {actions}
          </div>
        ),
      }
    : { actions };
}

export function readSessionLogSettings(values: Record<string, unknown>) {
  return { alwaysShowActions: values.alwaysShowActions === true };
}

export function SessionLogSettings({
  settings,
  onBack,
}: {
  settings: SettingsState;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const current = readSessionLogSettings(settings.values);

  return (
    <InlineView
      open
      onOpenChange={(open) => !open && onBack()}
      icon={<SlidersHorizontal className="size-4" />}
      title={t("sessionLogs.settingsTitle")}
    >
      <SectionCard
        title={t("sessionLogs.settingsDisplayTitle")}
        icon={<Rows3 className="size-3.5" />}
      >
        <SettingRow
          label={t("settings.alwaysShowActions.label")}
          description={t("settings.alwaysShowActions.description")}
        >
          <FakeSwitch
            checked={current.alwaysShowActions}
            onChange={(v) =>
              void settings.save({ ...settings.values, alwaysShowActions: v })
            }
          />
        </SettingRow>
      </SectionCard>
    </InlineView>
  );
}
