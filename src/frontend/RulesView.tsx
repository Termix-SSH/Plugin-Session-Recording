import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useToast, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  EmptyState,
  Facts,
  FormFooter,
  InlineView,
  ListBadge,
  ListRow,
  PanelList,
  SelectField,
  Switch,
  SwitchRow,
  TextField,
  useConfirm,
  ToolbarBand,
} from "@termix-ssh/plugin-sdk/ui";
import type {
  RecordingRule,
  SessionRecordingApi,
} from "./session-recording-api";

type Draft = Omit<RecordingRule, "id"> & { id?: number };

const EMPTY: Draft = {
  name: "",
  pattern: "",
  regex: false,
  target: "input",
  hosts: "all",
  severity: "warning",
  action: "alert",
  enabled: true,
};

const SEVERITY_KEY: Record<RecordingRule["severity"], string> = {
  info: "rules.severityInfo",
  warning: "rules.severityWarning",
  critical: "rules.severityCritical",
};

function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data?.error;
  return typeof data === "string" && data ? data : fallback;
}

export function RulesView({ api }: { api: SessionRecordingApi }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [rules, setRules] = useState<RecordingRule[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRules(await api.rules());
    } catch {
      setRules([]);
      toast.error(t("rules.loadError"));
    }
  }, [api, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (rule: RecordingRule, enabled: boolean) => {
    try {
      await api.saveRule({ ...rule, enabled });
      setRules((current) =>
        (current ?? []).map((item) =>
          item.id === rule.id ? { ...item, enabled } : item,
        ),
      );
    } catch (err) {
      toast.error(errorText(err, t("rules.saveError")));
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveRule(draft);
      setDraft(null);
      void load();
    } catch (err) {
      setError(errorText(err, t("rules.saveError")));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    const ok = await confirm({
      title: t("rules.deleteConfirm"),
      description: draft.name,
      confirmLabel: t("rules.delete"),
    });
    if (!ok) return;
    try {
      await api.deleteRule(draft.id);
      setDraft(null);
      void load();
    } catch {
      toast.error(t("rules.saveError"));
    }
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  return (
    <>
      <InlineView
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        title={draft?.id ? t("rules.edit") : t("rules.add")}
        icon={<ShieldAlert />}
        footer={
          <FormFooter
            onCancel={() => setDraft(null)}
            onSave={() => void save()}
            saving={saving}
            status={error ?? undefined}
            onDelete={draft?.id ? () => void remove() : undefined}
            deleteLabel={t("rules.delete")}
          />
        }
      >
        {draft && (
          <div className="flex flex-col gap-3 p-3">
            <TextField
              label={t("rules.name")}
              value={draft.name}
              onChange={(value) => set("name", value)}
            />
            <TextField
              label={t("rules.pattern")}
              value={draft.pattern}
              onChange={(value) => set("pattern", value)}
              hint={t("rules.patternHint")}
              mono
            />
            <SwitchRow
              label={t("rules.regex")}
              description={t("rules.regexHint")}
              checked={draft.regex}
              onChange={(value) => set("regex", value)}
            />
            <SelectField
              label={t("rules.target")}
              value={draft.target}
              onChange={(value) => set("target", value)}
              options={[
                { value: "input", label: t("rules.targetInput") },
                { value: "output", label: t("rules.targetOutput") },
              ]}
            />
            <SelectField
              label={t("rules.hosts")}
              value={draft.hosts}
              onChange={(value) => set("hosts", value)}
              options={[
                { value: "all", label: t("rules.hostsAll") },
                { value: "privileged", label: t("rules.hostsPrivileged") },
              ]}
            />
            <SelectField
              label={t("rules.severity")}
              value={draft.severity}
              onChange={(value) => set("severity", value)}
              options={[
                { value: "info", label: t("rules.severityInfo") },
                { value: "warning", label: t("rules.severityWarning") },
                { value: "critical", label: t("rules.severityCritical") },
              ]}
            />
            <SelectField
              label={t("rules.action")}
              value={draft.action}
              onChange={(value) => set("action", value)}
              options={[
                { value: "alert", label: t("rules.actionAlert") },
                { value: "end", label: t("rules.actionEnd") },
              ]}
            />
            <SwitchRow
              label={t("rules.enabled")}
              checked={draft.enabled}
              onChange={(value) => set("enabled", value)}
            />
          </div>
        )}
      </InlineView>
      {!draft && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ToolbarBand>
            <span className="flex-1 text-xs text-muted-foreground">
              {t("rules.intro")}
            </span>
            <AddButton
              label={t("rules.add")}
              onClick={() => setDraft({ ...EMPTY })}
            />
          </ToolbarBand>
          <PanelList
            empty={
              <EmptyState
                icon={ShieldAlert}
                title={rules === null ? t("live.loading") : t("rules.none")}
              />
            }
          >
            {(rules ?? []).map((rule, index) => (
              <ListRow
                key={rule.id}
                stripe={index}
                tone="muted"
                icon={<ShieldAlert />}
                title={rule.name}
                onClick={() => setDraft({ ...rule })}
                badges={
                  <>
                    {rule.action === "end" && (
                      <ListBadge>{t("rules.actionEnd")}</ListBadge>
                    )}
                    <ListBadge className="ml-auto">
                      {t(SEVERITY_KEY[rule.severity])}
                    </ListBadge>
                  </>
                }
                meta={
                  <Facts>
                    <span className="font-mono">{rule.pattern}</span>
                    <span>
                      {rule.target === "input"
                        ? t("rules.targetInput")
                        : t("rules.targetOutput")}
                    </span>
                    {rule.hosts === "privileged" && (
                      <span>{t("rules.hostsPrivileged")}</span>
                    )}
                  </Facts>
                }
                trailing={
                  <span onClick={(event) => event.stopPropagation()}>
                    <Switch
                      checked={rule.enabled}
                      aria-label={t("rules.enabled")}
                      onCheckedChange={(value: boolean) =>
                        void toggle(rule, value)
                      }
                    />
                  </span>
                }
              />
            ))}
          </PanelList>
        </div>
      )}
    </>
  );
}
