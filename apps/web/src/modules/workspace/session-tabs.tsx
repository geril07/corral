import { sessionStatus } from "@corral/client/agent-status";
import { describeSessionState } from "@corral/client/session-state";
import type { SessionEntry } from "@corral/client/workspace-tree";
import type { ActionId, ClientConfig } from "@corral/protocol/config";
import type { Session, SessionView } from "@corral/protocol/rpc";
import { useEffect, useRef, type Ref } from "react";
import {
  AgentIcon,
  Button,
  DropdownMenuItem,
  Icon,
  OverflowMenu,
  RowMenu,
  useTruncatedText,
} from "../../common/ui/index.ts";
import { formatBinding } from "../keymap/index.ts";
import { compactLaunchLabel, launchLine } from "../sessions/index.ts";
import { StatusIndicator } from "../status/index.ts";

export interface SessionTabsProps {
  entries: readonly SessionEntry[];
  labels: ReadonlyMap<string, string>;
  currentId: string | undefined;
  changes?: { current: boolean; onSelect: () => void; hint?: string | undefined } | undefined;
  config?: ClientConfig | undefined;
  position?: "top" | "bottom";
  draftLabel?: string | undefined;
  agentPickerAnchor?: Ref<HTMLButtonElement> | undefined;
  view?: { value: SessionView; reason?: string | undefined; onSwitch: () => void } | undefined;
  onSelect: (entry: SessionEntry) => void;
  onStop: (session: Session) => void;
  onRestart: (session: Session) => void;
  onRemove: (session: Session) => void;
  onRename: (entry: SessionEntry, opener?: HTMLElement) => void;
  onNewShell: (opener?: HTMLElement) => void;
  onNewAgent: (opener?: HTMLElement) => void;
}

/** Sessions stay in their own row; secondary actions occupy no hidden-width slots. */
export function SessionTabs(props: SessionTabsProps) {
  const { entries, labels, currentId, config, changes, view, position = "top" } = props;
  const changesCurrent = changes?.current ?? false;
  const strip = useRef<HTMLDivElement>(null);
  const hint = (label: string, action: ActionId) =>
    config ? `${label} · ${formatBinding(config, action)}` : label;

  useEffect(() => {
    if (entries.length === 0) return;
    strip.current
      ?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(currentId ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentId, entries.length]);

  const step = (offset: 1 | -1 | "first" | "last") => {
    const index = entries.findIndex((entry) => entry.id === currentId);
    const next =
      offset === "first"
        ? entries[0]
        : offset === "last"
          ? entries[entries.length - 1]
          : entries[((index < 0 ? 0 : index) + offset + entries.length) % entries.length];
    if (next) props.onSelect(next);
  };
  return (
    <div
      data-tab-position={position}
      className={`flex min-w-0 shrink-0 items-center gap-2 px-2 py-1 ${position === "bottom" ? "order-last border-t border-border" : "border-b border-border"}`}
    >
      <div
        ref={strip}
        role="tablist"
        aria-label="Sessions"
        className="no-scrollbar flex h-(--tabstrip) min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto"
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return;
          const action = (
            {
              ArrowRight: () => step(1),
              ArrowLeft: () => step(-1),
              Home: () => step("first"),
              End: () => step("last"),
            } as Record<string, () => void>
          )[event.key];
          if (action) {
            event.preventDefault();
            action();
          }
        }}
      >
        {props.draftLabel !== undefined && (
          <Button
            role="tab"
            aria-label="New task draft"
            aria-selected
            variant="secondary"
            layout="tab"
          >
            <Icon name="task" />
            {props.draftLabel}
          </Button>
        )}
        {entries.map((entry, index) => (
          <SessionTab
            key={entry.id}
            entry={entry}
            name={labels.get(entry.session.id) ?? entry.session.kind}
            number={index < 9 ? index + 1 : undefined}
            current={entry.id === currentId}
            behind={changesCurrent && entry.id === currentId}
            hint={hint}
            onSelect={() => props.onSelect(entry)}
            onStop={() => props.onStop(entry.session)}
            onRestart={() => props.onRestart(entry.session)}
            onRemove={() => props.onRemove(entry.session)}
            onRename={(opener) => props.onRename(entry, opener)}
          />
        ))}
        {changes && (
          <Button
            role="tab"
            aria-selected={changes.current}
            tabIndex={changes.current ? 0 : -1}
            variant={changes.current ? "secondary" : "ghost"}
            layout="tab"
            aria-label="Changes"
            title={changes.hint}
            data-changes-tab=""
            onClick={changes.onSelect}
          >
            <span className="min-w-0 truncate">Changes</span>
          </Button>
        )}
        {props.draftLabel === undefined && (
          <div className="flex shrink-0 items-center">
            <OverflowMenu
              label="Add session"
              triggerRef={props.agentPickerAnchor}
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
        )}
      </div>
      {view && (
        <div role="group" aria-label="Session view" className="flex shrink-0 items-center gap-0.5">
          {(["chat", "terminal"] as const).map((value) => (
            <Button
              key={value}
              size="xs"
              variant={view.value === value && !changesCurrent ? "secondary" : "ghost"}
              aria-label={value === "chat" ? "Chat view" : "Terminal view"}
              aria-pressed={view.value === value && !changesCurrent}
              disabled={changesCurrent || (value !== view.value && view.reason !== undefined)}
              title={
                value !== view.value
                  ? (view.reason ?? hint("Switch view", "switch-view"))
                  : undefined
              }
              onClick={() => {
                if (value !== view.value) view.onSwitch();
              }}
            >
              <Icon name={value === "chat" ? "chat" : "terminal"} />
              {value === "chat" ? "Chat" : "Terminal"}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionTab({
  entry,
  name,
  number,
  current,
  behind,
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
  behind: boolean;
  hint: (label: string, action: ActionId) => string;
  onSelect: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRemove: () => void;
  onRename: (opener?: HTMLElement) => void;
}) {
  const { session } = entry;
  const trigger = useRef<HTMLButtonElement>(null);
  const running = session.state === "running";
  const { badge, action, note } = describeSessionState(session);
  const status = sessionStatus(session);
  const launch = compactLaunchLabel(session);
  const { observe, clipped } = useTruncatedText(name);
  const title =
    [
      clipped ? name : undefined,
      session.launch ? launchLine(session)?.details : undefined,
      status?.message,
      badge,
      action,
      note,
    ]
      .filter(Boolean)
      .join("\n") || undefined;
  const failed = badge === "failed";
  const glyphState = failed
    ? {
        state: "error" as const,
        updatedAt: status?.updatedAt ?? session.createdAt,
        ...(status?.state === "error" && status.message ? { message: status.message } : {}),
      }
    : status?.state === "working" || status?.state === "blocked"
      ? status
      : undefined;
  return (
    <RowMenu
      label={`Session actions for ${name}`}
      hint={clipped ? (title ?? name) : undefined}
      trigger={
        <Button
          ref={trigger}
          role="tab"
          aria-selected={current && !behind}
          aria-current={behind ? "true" : undefined}
          tabIndex={current ? 0 : -1}
          variant={current ? "secondary" : "ghost"}
          layout="tab"
          aria-label={[name, launch, badge].filter(Boolean).join(" ")}
          title={clipped ? undefined : title}
          data-session-id={entry.id}
          onClick={onSelect}
          onKeyDown={(event) => {
            if (event.key === "Enter" && current && !running) {
              event.preventDefault();
              onRestart();
            }
          }}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {number !== undefined && (
              <span className="text-xs text-muted-foreground" aria-hidden>
                {number}
              </span>
            )}
            <span className="flex w-5 shrink-0 items-center justify-center">
              {glyphState ? (
                <StatusIndicator status={glyphState} size="chrome" />
              ) : (
                <AgentIcon kind={session.kind} size="chrome" />
              )}
            </span>
            <span
              ref={observe}
              className={running ? "min-w-0 truncate" : "min-w-0 truncate text-muted-foreground"}
            >
              {name}
            </span>
          </span>
        </Button>
      }
    >
      {running ? (
        <DropdownMenuItem title={hint("Stop session", "stop-session")} onClick={onStop}>
          Stop {name}
        </DropdownMenuItem>
      ) : (
        action !== undefined && (
          <DropdownMenuItem title={hint(action, "restart-session")} onClick={onRestart}>
            {session.state === "unresumable" ? action : `${action} ${name}`}
          </DropdownMenuItem>
        )
      )}
      <DropdownMenuItem onClick={(event) => onRename(trigger.current ?? event.currentTarget)}>
        Rename…
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onClick={onRemove}>
        Remove session…
      </DropdownMenuItem>
    </RowMenu>
  );
}
