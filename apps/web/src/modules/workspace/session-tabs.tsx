import { sessionStatus } from "@corral/client/agent-status";
import { describeSessionState } from "@corral/client/session-state";
import type { SessionEntry } from "@corral/client/workspace-tree";
import type { ActionId, ClientConfig } from "@corral/protocol/config";
import type { Session } from "@corral/protocol/rpc";
import { useEffect, useRef } from "react";
import { Button, DropdownMenuItem, IconButton, Icon, OverflowMenu } from "../../common/ui/index.ts";
import { formatBinding } from "../keymap/index.ts";
import { compactLaunchLabel, launchLine } from "../sessions/index.ts";
import { StatusIndicator } from "../status/index.ts";

export interface SessionTabsProps {
  /** The current task's sessions, in creation order. */
  entries: readonly SessionEntry[];
  /** The name each session shows (`sessionLabels`); ancestors pass it so tabs and rows agree. */
  labels: ReadonlyMap<string, string>;
  currentId: string | undefined;
  /** Effective bindings for the tooltips and the end hint; absent in a bare tab-strip test. */
  config?: ClientConfig | undefined;
  onSelect: (entry: SessionEntry) => void;
  onStop: (session: Session) => void;
  onRestart: (session: Session) => void;
  onRemove: (session: Session) => void;
  onRename: (entry: SessionEntry, opener?: HTMLElement) => void;
  onNewShell: (opener?: HTMLElement) => void;
  onNewAgent: (opener?: HTMLElement) => void;
}

/**
 * One 32 px tab per session of the current task (`layout.md`, **Session tabs**): a number hint,
 * the session's glyph (its status glyph while working or blocked), its name, and — on hover or
 * focus — stop/restart, its menu and close.
 */
export function SessionTabs(props: SessionTabsProps) {
  const { entries, labels, currentId, config } = props;
  const strip = useRef<HTMLDivElement>(null);
  const hint = (label: string, action: ActionId) =>
    config ? `${label} · ${formatBinding(config, action)}` : label;

  // The selected tab stays in view when the strip scrolls (`layout.md`, **Session tabs**).
  useEffect(() => {
    const selected = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  const step = (offset: 1 | -1 | "first" | "last") => {
    const index = entries.findIndex((entry) => entry.id === currentId);
    const next =
      offset === "first"
        ? entries[0]
        : offset === "last"
          ? entries[entries.length - 1]
          : entries[((index < 0 ? 0 : index) + offset + entries.length) % entries.length];
    if (next === undefined) return;
    props.onSelect(next);
    strip.current
      ?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(next.id)}"]`)
      ?.focus();
  };

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Sessions"
      className="flex h-8 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border px-1"
      // Pressing a tab must not take the keyboard from the terminal (`ux.md`).
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const keys: Record<string, () => void> = {
          ArrowRight: () => step(1),
          ArrowLeft: () => step(-1),
          Home: () => step("first"),
          End: () => step("last"),
        };
        const action = keys[event.key];
        if (!action) return;
        event.preventDefault();
        action();
      }}
    >
      {entries.map((entry, index) => (
        <SessionTab
          key={entry.id}
          entry={entry}
          name={labels.get(entry.session.id) ?? entry.session.kind}
          number={index < 9 ? index + 1 : undefined}
          current={entry.id === currentId}
          hint={hint}
          onSelect={() => props.onSelect(entry)}
          onStop={() => props.onStop(entry.session)}
          onRestart={() => props.onRestart(entry.session)}
          onRemove={() => props.onRemove(entry.session)}
          onRename={(opener) => props.onRename(entry, opener)}
        />
      ))}
      <div className="flex shrink-0 items-center">
        <OverflowMenu
          label="Add session"
          icon="add"
          tooltip={`Add session · ${hint("shell", "new-terminal")} / ${hint("agent", "new-agent")}`}
        >
          <DropdownMenuItem onClick={(event) => props.onNewShell(event.currentTarget)}>
            Shell
          </DropdownMenuItem>
          <DropdownMenuItem onClick={(event) => props.onNewAgent(event.currentTarget)}>
            Agent…
          </DropdownMenuItem>
        </OverflowMenu>
      </div>
    </div>
  );
}

function SessionTab({
  entry,
  name,
  number,
  current,
  hint,
  onSelect,
  onStop,
  onRestart,
  onRemove,
  onRename,
}: {
  entry: SessionEntry;
  name: string;
  number: number | undefined;
  current: boolean;
  hint: (label: string, action: ActionId) => string;
  onSelect: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRemove: () => void;
  onRename: (opener?: HTMLElement) => void;
}) {
  const { session } = entry;
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const running = session.state === "running";
  const { badge, note } = describeSessionState(session);
  const status = sessionStatus(session);
  const launch = compactLaunchLabel(session);
  const launchDetails = session.launch ? launchLine(session)?.details : undefined;
  const title = [launchDetails, status?.message, note].filter(Boolean).join("\n") || undefined;
  // Working and blocked are what the glyph must carry; otherwise the session's kind shows.
  const glyphState =
    status?.state === "working" || status?.state === "blocked" ? status : undefined;

  return (
    <div className="group flex shrink-0 items-center">
      <Button
        role="tab"
        aria-selected={current}
        tabIndex={current ? 0 : -1}
        variant={current ? "secondary" : "ghost"}
        layout="tab"
        aria-label={[name, launch, badge].filter(Boolean).join(" ")}
        title={title}
        data-session-id={entry.id}
        onClick={onSelect}
        onKeyDown={(event) => {
          // Enter on the selected session that is not running starts it again.
          if (event.key !== "Enter" || !current || running) return;
          event.preventDefault();
          onRestart();
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {number !== undefined && (
            <span className="text-xs text-muted-foreground" aria-hidden>
              {number}
            </span>
          )}
          {glyphState ? (
            <StatusIndicator status={glyphState} size="chrome" />
          ) : (
            <Icon name={session.kind === "shell" ? "terminal" : "agent"} />
          )}
          <span className={running ? "min-w-0 truncate" : "min-w-0 truncate text-muted-foreground"}>
            {name}
          </span>
        </span>
      </Button>
      <span className={tabActionsClass(current)}>
        <IconButton
          label={running ? `stop ${name}` : `restart ${name}`}
          tooltip={
            running
              ? hint(`Stop ${name}`, "stop-session")
              : hint(`Restart ${name}`, "restart-session")
          }
          icon={running ? "stop" : "restart"}
          size="icon-xs"
          onClick={running ? onStop : onRestart}
        />
        <OverflowMenu label={`Session actions for ${name}`} triggerRef={menuTrigger}>
          <DropdownMenuItem
            onClick={(event) => onRename(menuTrigger.current ?? event.currentTarget)}
          >
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            Remove session…
          </DropdownMenuItem>
        </OverflowMenu>
        <IconButton
          label={`Close ${name}`}
          tooltip={`Close ${name} (asks first)`}
          icon="close"
          size="icon-xs"
          onClick={onRemove}
        />
      </span>
    </div>
  );
}

/** Stop, the menu and close appear on hover or focus, and stay on the selected tab. */
function tabActionsClass(current: boolean): string {
  return current
    ? "flex items-center"
    : "flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100";
}
