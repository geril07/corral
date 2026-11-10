import { ActionId, DIRECT_ACTION_LABELS, DirectActionId } from "@corral/protocol/config";
import { Kbd } from "../../common/ui/index.ts";
import { ACTION_LABELS, formatBinding, problemAtPath, useConfig } from "../keymap/index.ts";
import { SettingsCard, SettingsRow } from "./settings-primitives.tsx";

/**
 * Every action with the key it currently runs from, and why a file entry fell back to it. The
 * reason is the server's own problem at `keys.bindings.<action>` / `keys.direct.<action>`; nothing
 * here finds conflicts.
 */
export function KeyboardSection() {
  const { config, problems } = useConfig();
  return (
    <>
      <SettingsCard>
        <SettingsRow
          id="settings-keyboard-prefix"
          title="Prefix"
          description="The chord that starts a key sequence"
          control={<Kbd>{config.keys.prefix}</Kbd>}
        />
        {ActionId.options.map((action) => {
          const binding = formatBinding(config, action);
          const problem = problemAtPath(problems, `keys.bindings.${action}`);
          return (
            <SettingsRow
              key={action}
              id={`settings-keyboard-binding-${action}`}
              title={ACTION_LABELS[action]}
              description={problem?.message}
              control={
                binding === "unbound" ? (
                  <span className="settings-row-value">unbound</span>
                ) : (
                  <Kbd>{binding}</Kbd>
                )
              }
            />
          );
        })}
      </SettingsCard>
      <SettingsCard title="Direct commands" note="mod = Cmd on macOS, Ctrl elsewhere">
        {DirectActionId.options.map((action) => {
          const binding = config.keys.direct[action];
          const problem = problemAtPath(problems, `keys.direct.${action}`);
          return (
            <SettingsRow
              key={action}
              id={`settings-keyboard-direct-${action}`}
              title={DIRECT_ACTION_LABELS[action]}
              description={problem?.message}
              control={
                binding === null ? (
                  <span className="settings-row-value">unbound</span>
                ) : (
                  <Kbd>{binding}</Kbd>
                )
              }
            />
          );
        })}
      </SettingsCard>
    </>
  );
}
