import { ActionId } from "@corral/protocol/config";
import { CommandPalette, Dialog, Kbd } from "../../common/ui/index.ts";
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
    <Dialog title="Command palette" onClose={onClose}>
      <CommandPalette.Root label="Commands" loop>
        <CommandPalette.Input aria-label="Search actions" placeholder="Type an action…" autoFocus />
        <CommandPalette.List>
          {groups.map(({ group, actions: groupActions }) => {
            if (groupActions.length === 0) return null;
            return (
              <CommandPalette.Group key={group} heading={group}>
                {groupActions.map((action) => {
                  const { label, enabled } = actions[action];
                  return (
                    <CommandPalette.Item
                      key={action}
                      value={`${action} ${label}`}
                      disabled={!enabled}
                      onSelect={() => onRun(action)}
                    >
                      <span className="flex-1 truncate">{label}</span>
                      <Kbd className="shrink-0">{formatBinding(config, action)}</Kbd>
                    </CommandPalette.Item>
                  );
                })}
              </CommandPalette.Group>
            );
          })}
          <CommandPalette.Empty>No action matches.</CommandPalette.Empty>
        </CommandPalette.List>
      </CommandPalette.Root>
    </Dialog>
  );
}
