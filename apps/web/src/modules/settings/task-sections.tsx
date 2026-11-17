import { namingConfigured } from "@corral/protocol/config";
import { SettingsCard, SettingsNote, SettingsRow } from "./settings-primitives.tsx";
import { namingSettingRows, snoozeSettingRows, taskSettingRows } from "./task-settings-rows.ts";
import { useConfig } from "../keymap/index.ts";

/** The values task creation and the composer use, each with the layer it resolved from. */
export function TaskDefaultsSection() {
  const { config, loaded } = useConfig();
  if (!loaded) return <PendingConfig />;
  return (
    <>
      <SettingsCard>
        <SettingRows rows={taskSettingRows(config.tasks)} prefix="settings-defaults" />
      </SettingsCard>
      <SettingsNote>
        A launch profile wins over an agent, and a model overrides the profile's model
      </SettingsNote>
    </>
  );
}

/** `[naming]`, and the note that an empty section means seed titles only. */
export function NamingSection() {
  const { config, loaded } = useConfig();
  if (!loaded) return <PendingConfig />;
  return (
    <>
      <SettingsCard>
        <SettingRows rows={namingSettingRows(config.naming)} prefix="settings-naming" />
      </SettingsCard>
      {!namingConfigured(config.naming) && (
        <SettingsNote>
          No naming profile or agent is set, so a task keeps the title derived from its prompt. Add{" "}
          <span className="font-mono text-xs">[naming]</span> with a profile, or an agent and model,
          to generate one
        </SettingsNote>
      )}
    </>
  );
}

/** `[snooze]`: the wake times the row menu offers, read from the file; the menu is edited there. */
export function SnoozeSection() {
  const { config, loaded } = useConfig();
  if (!loaded) return <PendingConfig />;
  return (
    <>
      <SettingsCard>
        <SettingRows rows={snoozeSettingRows(config.snooze)} prefix="settings-snooze" />
      </SettingsCard>
      {config.snooze.presets.value.length === 0 && (
        <SettingsNote>
          No presets are set, so the row menu offers only{" "}
          <span className="font-mono text-xs">Custom…</span>. Add{" "}
          <span className="font-mono text-xs">[snooze]</span> with a{" "}
          <span className="font-mono text-xs">presets</span> list to name wake times
        </SettingsNote>
      )}
    </>
  );
}

/** Before the server's first config the built-in values are incomplete, so nothing is shown. */
function PendingConfig() {
  return <SettingsNote>waiting for the server's config…</SettingsNote>;
}

function SettingRows({
  rows,
  prefix,
}: {
  rows: readonly { key: string; label: string; value: string; source: string }[];
  prefix: string;
}) {
  return (
    <>
      {rows.map((row) => (
        <SettingsRow
          key={row.key}
          id={`${prefix}-${row.key}`}
          title={row.label}
          value={row.value}
          source={row.source}
        />
      ))}
    </>
  );
}
