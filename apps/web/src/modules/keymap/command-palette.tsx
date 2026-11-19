import { ActionId } from "@corral/protocol/config";
import { useRef, type ComponentProps } from "react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  TaskCommandDialog,
  Kbd,
  useTaskDialogClose,
} from "../../common/ui/index.ts";
import { ACTION_GROUPS, formatBinding, type ActionTable } from "./actions.ts";
import { useConfig } from "./config-context.tsx";

interface CommandPaletteDialogProps {
  actions: ActionTable;
  /** The chosen action, after the palette has closed and returned its opener's focus. */
  onClose: (action?: ActionId) => void;
  finalFocus?: ComponentProps<typeof TaskCommandDialog>["finalFocus"];
}

/**
 * Every action with its current key; typing filters, Enter runs the highlighted one. A choice
 * closes through the dialog's own exit, so the overlay's final-focus contract runs before the
 * destination surface takes the keyboard.
 */
export function CommandPaletteDialog({ actions, onClose, finalFocus }: CommandPaletteDialogProps) {
  const chosen = useRef<ActionId | undefined>(undefined);
  return (
    <TaskCommandDialog
      title="Command palette"
      finalFocus={finalFocus}
      onClose={() => onClose(chosen.current)}
    >
      <PaletteCommands
        actions={actions}
        onChoose={(action) => {
          chosen.current = action;
        }}
      />
    </TaskCommandDialog>
  );
}

function PaletteCommands({
  actions,
  onChoose,
}: {
  actions: ActionTable;
  onChoose: (action: ActionId) => void;
}) {
  const { config } = useConfig();
  const close = useTaskDialogClose();
  const groups = ACTION_GROUPS.map((group) => ({
    group,
    actions: ActionId.options.filter((action) => actions[action].group === group),
  }));

  return (
    <Command label="Commands" loop>
      <CommandInput aria-label="Search actions" placeholder="Type an action…" autoFocus />
      <CommandList>
        {groups.map(({ group, actions: groupActions }) => {
          if (groupActions.length === 0) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {groupActions.map((action) => {
                const { label, enabled, reason } = actions[action];
                return (
                  <CommandItem
                    key={action}
                    value={`${action} ${label}`}
                    disabled={!enabled}
                    onSelect={() => {
                      if (!enabled) return;
                      onChoose(action);
                      close?.();
                    }}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span data-palette-label="" className="truncate">
                        {label}
                      </span>
                      {!enabled && reason && (
                        <span
                          data-palette-reason=""
                          className="truncate text-xs text-muted-foreground"
                        >
                          {reason}
                        </span>
                      )}
                    </span>
                    <Kbd>{formatBinding(config, action)}</Kbd>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}
        <CommandEmpty>No action matches.</CommandEmpty>
      </CommandList>
    </Command>
  );
}
