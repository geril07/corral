import { ActionId } from "@corral/protocol/config";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  TaskDialog,
  Kbd,
} from "../../common/ui/index.ts";
import { ACTION_GROUPS, formatBinding, type ActionTable } from "./actions.ts";
import { useConfig } from "./config-context.tsx";

interface CommandPaletteDialogProps {
  actions: ActionTable;
  onRun: (action: ActionId) => void;
  onClose: () => void;
}

/** Every action with its current key; typing filters, Enter runs the highlighted one. */
export function CommandPaletteDialog({ actions, onRun, onClose }: CommandPaletteDialogProps) {
  const { config } = useConfig();
  const groups = ACTION_GROUPS.map((group) => ({
    group,
    actions: ActionId.options.filter((action) => actions[action].group === group),
  }));

  return (
    <TaskDialog title="Command palette" onClose={onClose}>
      <Command label="Commands" loop>
        <CommandInput aria-label="Search actions" placeholder="Type an action…" autoFocus />
        <CommandList>
          {groups.map(({ group, actions: groupActions }) => {
            if (groupActions.length === 0) return null;
            return (
              <CommandGroup key={group} heading={group}>
                {groupActions.map((action) => {
                  const { label, enabled } = actions[action];
                  return (
                    <CommandItem
                      key={action}
                      value={`${action} ${label}`}
                      disabled={!enabled}
                      onSelect={() => onRun(action)}
                    >
                      <span className="flex-1 truncate">{label}</span>
                      <Kbd className="shrink-0">{formatBinding(config, action)}</Kbd>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            );
          })}
          <CommandEmpty>No action matches.</CommandEmpty>
        </CommandList>
      </Command>
    </TaskDialog>
  );
}
