import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, RadioChoice, RadioGroup, TaskDialog } from "../../common/ui/index.ts";
import { useConfig } from "../keymap/index.ts";
import { useAppearance, UI_SCALES } from "./appearance.tsx";
import { AgentsSection } from "./agents.tsx";
import { ConfigFileSection } from "./config-file-section.tsx";
import { EffectiveKeys } from "./effective-keys.tsx";
import { ProfileList } from "./profile-list.tsx";
import { ProjectOverrides, TaskDefaults, TaskNaming } from "./task-defaults.tsx";
import { ModelManagement, type ModelManagementTarget } from "./model-management.tsx";
import { useSettingsActivity } from "./settings-activity.tsx";

const SECTIONS = [
  ["appearance", "Appearance"],
  ["models", "Models"],
  ["keys", "Effective keys"],
  ["tasks", "Task defaults"],
  ["naming", "Task naming"],
  ["projects", "Project overrides"],
  ["profiles", "Agent profiles"],
  ["agents", "Agents"],
  ["config", "Config file"],
] as const;
type SectionId = (typeof SECTIONS)[number][0];
const panelId = (id: SectionId) => `settings-panel-${id}`;

/** Hidden panels keep disclosures and data subscriptions while their own scroll is restored. */
function SettingsSection({
  id,
  current,
  children,
}: {
  id: SectionId;
  current: SectionId;
  children: ReactNode;
}) {
  const heading = `${panelId(id)}-title`;
  return (
    <section
      id={panelId(id)}
      hidden={id !== current}
      aria-labelledby={heading}
      className={id === "models" && id === current ? "flex h-full min-h-0 flex-col" : undefined}
    >
      <h2 id={heading} className="mt-0 mb-3 text-sm font-semibold">
        {SECTIONS.find(([key]) => key === id)![1]}
      </h2>
      {children}
    </section>
  );
}

export function SettingsScreen({
  onClose,
  modelTarget,
}: {
  onClose: () => void;
  modelTarget?: ModelManagementTarget | undefined;
}) {
  const { profiles } = useConfig();
  const registerSettings = useSettingsActivity()?.register;
  useLayoutEffect(() => registerSettings?.(), [registerSettings]);
  const { appearance, setScale, setTabPosition } = useAppearance();
  const [current, setCurrent] = useState<SectionId>(modelTarget ? "models" : "appearance");
  const [modelsDirty, setModelsDirty] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<SectionId, number>());
  const visit = (id: SectionId) => {
    positions.current.set(current, content.current?.scrollTop ?? 0);
    setCurrent(id);
  };
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = positions.current.get(current) ?? 0;
  }, [current, content, positions]);
  return (
    <TaskDialog
      title="Settings"
      layout="settings"
      onClose={() => {
        if (modelsBusy) return;
        if (modelsDirty) setClosing(true);
        else onClose();
      }}
    >
      {closing && modelsDirty && (
        <div
          role="alert"
          className="flex h-(--chrome-header) shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-2"
        >
          <span className="text-xs">Model preferences have unsaved changes.</span>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>
              Keep editing
            </Button>
            <Button size="sm" variant="destructive" disabled={modelsBusy} onClick={onClose}>
              Discard and close
            </Button>
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings categories"
          className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3"
        >
          {SECTIONS.map(([id, label]) => (
            <Button
              key={id}
              variant={current === id ? "secondary" : "ghost"}
              layout="navigation"
              aria-current={current === id ? "true" : undefined}
              aria-controls={panelId(id)}
              onClick={() => visit(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        <div ref={content} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
          {current !== "appearance" && current !== "models" && (
            <div className="mb-3">
              <Badge variant="secondary">read-only</Badge>
            </div>
          )}
          <SettingsSection id="appearance" current={current}>
            <p className="mt-0 text-xs text-muted-foreground">
              Saved on this device. Model menu preferences are shared; config file categories are
              read-only.
            </p>
            <h3 className="text-sm font-medium">Session tabs</h3>
            <RadioGroup
              aria-label="Session tab position"
              value={appearance.tabPosition}
              onValueChange={(value) => {
                if (value === "top" || value === "bottom") setTabPosition(value);
              }}
            >
              <RadioChoice value="top">Top</RadioChoice>
              <RadioChoice value="bottom">Bottom</RadioChoice>
            </RadioGroup>
            <h3 className="text-sm font-medium">Interface text scale</h3>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Interface text scale">
              {UI_SCALES.map((scale) => (
                <Button
                  key={scale}
                  size="sm"
                  variant={appearance.scale === scale ? "secondary" : "ghost"}
                  aria-pressed={appearance.scale === scale}
                  onClick={() => setScale(scale)}
                >
                  {scale}%
                </Button>
              ))}
            </div>
            <p className="mb-0 text-xs text-muted-foreground">
              Relative to the system scale; terminal text stays at 14 px.
            </p>
          </SettingsSection>
          <SettingsSection id="models" current={current}>
            <ModelManagement
              active={current === "models"}
              target={modelTarget}
              onDirty={setModelsDirty}
              onBusy={setModelsBusy}
            />
          </SettingsSection>
          <SettingsSection id="keys" current={current}>
            <EffectiveKeys />
          </SettingsSection>
          <SettingsSection id="tasks" current={current}>
            <TaskDefaults />
          </SettingsSection>
          <SettingsSection id="naming" current={current}>
            <TaskNaming />
          </SettingsSection>
          <SettingsSection id="projects" current={current}>
            <ProjectOverrides />
          </SettingsSection>
          <SettingsSection id="profiles" current={current}>
            <ProfileList profiles={profiles} />
          </SettingsSection>
          <SettingsSection id="agents" current={current}>
            <AgentsSection />
          </SettingsSection>
          <SettingsSection id="config" current={current}>
            <ConfigFileSection />
          </SettingsSection>
        </div>
      </div>
    </TaskDialog>
  );
}
