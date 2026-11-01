import { useCallback, useEffect } from "react";
import { Badge, Button, Icon, Screen } from "../../common/ui/index.ts";
import { useConfig } from "../keymap/index.ts";
import { AgentsSection } from "./agents.tsx";
import { ConfigFileSection } from "./config-file-section.tsx";
import { EffectiveKeys } from "./effective-keys.tsx";
import { ProfileList } from "./profile-list.tsx";
import { requestSettingsFocus } from "./settings-focus.ts";
import { ProjectOverrides, TaskDefaults, TaskNaming } from "./task-defaults.tsx";

/**
 * The read-only settings route: effective keys, task defaults and their layers, naming, the
 * config's profiles, the agents with their availability, and the file's problems.
 */
export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const { profiles } = useConfig();
  const close = useCallback(() => {
    requestSettingsFocus();
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [close]);

  return (
    <Screen>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" aria-label="Back to workspace" autoFocus onClick={close}>
          <Icon name="back" />
          Back
        </Button>
        <h1 className="m-0 text-base font-semibold">Settings</h1>
        <Badge variant="secondary">read-only</Badge>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section aria-labelledby="settings-keys" className="mb-5">
          <h2 id="settings-keys" className="mt-0 mb-1 text-sm font-semibold">
            Effective keys
          </h2>
          <EffectiveKeys />
        </section>
        <section aria-labelledby="settings-tasks" className="mb-5">
          <h2 id="settings-tasks" className="mt-0 mb-1 text-sm font-semibold">
            Task defaults
          </h2>
          <TaskDefaults />
        </section>
        <section aria-labelledby="settings-naming" className="mb-5">
          <h2 id="settings-naming" className="mt-0 mb-1 text-sm font-semibold">
            Task naming
          </h2>
          <TaskNaming />
        </section>
        <section aria-labelledby="settings-projects" className="mb-5">
          <h2 id="settings-projects" className="mt-0 mb-1 text-sm font-semibold">
            Project overrides
          </h2>
          <ProjectOverrides />
        </section>
        <section aria-labelledby="settings-profiles" className="mb-5">
          <h2 id="settings-profiles" className="mt-0 mb-1 text-sm font-semibold">
            Agent profiles
          </h2>
          <ProfileList profiles={profiles} />
        </section>
        <section aria-labelledby="settings-agents" className="mb-5">
          <h2 id="settings-agents" className="mt-0 mb-1 text-sm font-semibold">
            Agents
          </h2>
          <AgentsSection />
        </section>
        <section aria-labelledby="settings-config">
          <h2 id="settings-config" className="mt-0 mb-1 text-sm font-semibold">
            Config file
          </h2>
          <ConfigFileSection />
        </section>
      </div>
    </Screen>
  );
}
