import { ActionId } from "@corral/protocol/config";
import { Kbd } from "../../common/ui/index.ts";
import { ACTION_LABELS, formatBinding, useConfig } from "../keymap/index.ts";

/** Every action with the key it currently runs from; an unbound action says so. */
export function EffectiveKeys() {
  const { config } = useConfig();
  return (
    <ul className="m-0 list-none p-0">
      <li className="flex items-center gap-2 py-0.5">
        <span className="flex-1">Prefix</span>
        <Kbd>{config.keys.prefix}</Kbd>
      </li>
      {ActionId.options.map((action) => {
        const binding = formatBinding(config, action);
        return (
          <li key={action} className="flex items-center gap-2 py-0.5">
            <span className="flex-1 truncate">{ACTION_LABELS[action]}</span>
            {binding === "unbound" ? (
              <span className="text-text-muted">unbound</span>
            ) : (
              <Kbd>{binding}</Kbd>
            )}
          </li>
        );
      })}
    </ul>
  );
}
