import { ActionId, DIRECT_ACTION_LABELS, DirectActionId } from "@corral/protocol/config";
import { useId } from "react";
import { Kbd } from "../../common/ui/index.ts";
import { ACTION_LABELS, formatBinding, problemAtPath, useConfig } from "../keymap/index.ts";

/**
 * Every action with the key it currently runs from, and why a file entry fell back to it. The
 * reason is the server's own problem at `keys.bindings.<action>` / `keys.direct.<action>`; nothing
 * here finds conflicts.
 */
export function EffectiveKeys() {
  const { config, problems } = useConfig();
  const reasonId = useId();
  return (
    <ul className="m-0 list-none p-0">
      <li className="flex items-center gap-2 py-0.5">
        <span className="flex-1">Prefix</span>
        <Kbd>{config.keys.prefix}</Kbd>
      </li>
      {ActionId.options.map((action) => {
        const binding = formatBinding(config, action);
        const path = `keys.bindings.${action}`;
        const problem = problemAtPath(problems, path);
        const descriptionId = `${reasonId}-${action}`;
        return (
          <li
            key={action}
            className="py-0.5"
            aria-describedby={problem === undefined ? undefined : descriptionId}
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate">{ACTION_LABELS[action]}</span>
              {binding === "unbound" ? (
                <span className="text-muted-foreground">unbound</span>
              ) : (
                <Kbd>{binding}</Kbd>
              )}
            </div>
            {problem !== undefined && (
              <p
                id={descriptionId}
                className="m-0 mt-0.5 break-words text-xs text-muted-foreground"
              >
                {problem.message}
              </p>
            )}
          </li>
        );
      })}
      <li className="mt-3 font-medium text-muted-foreground">
        Direct commands <span className="font-normal">(mod = Cmd on macOS, Ctrl elsewhere)</span>
      </li>
      {DirectActionId.options.map((action) => {
        const binding = config.keys.direct[action];
        const path = `keys.direct.${action}`;
        const problem = problemAtPath(problems, path);
        const descriptionId = `${reasonId}-direct-${action}`;
        return (
          <li
            key={action}
            className="py-0.5"
            aria-describedby={problem === undefined ? undefined : descriptionId}
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate">{DIRECT_ACTION_LABELS[action]}</span>
              {binding === null ? (
                <span className="text-muted-foreground">unbound</span>
              ) : (
                <Kbd>{binding}</Kbd>
              )}
            </div>
            {problem !== undefined && (
              <p
                id={descriptionId}
                className="m-0 mt-0.5 break-words text-xs text-muted-foreground"
              >
                {problem.message}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
