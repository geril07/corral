import { createDirectKeymap, createPrefixKeymap } from "@corral/client/prefix-keymap";
import { DirectActionId } from "@corral/protocol/config";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { copyText, type CopyOutcome } from "../../common/lib/clipboard.ts";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  Icon,
  TooltipProvider,
  VisualIconButton,
  VisualResizeHandle,
  VisualSearchAction,
  VisualSidebar,
  VisualTaskCard,
  type VisualShortcut,
  type VisualTaskRow,
} from "../../common/ui/index.ts";
import { modifierPlatform, usePrefixMode } from "../keymap/index.ts";
import {
  useVisualSidebarPane,
  VISUAL_SIDEBAR_MAX_WIDTH,
  VISUAL_SIDEBAR_MIN_WIDTH,
} from "./sidebar-pane.ts";

/** What a row's secondary actions do; every one reaches a real surface in the production host. */
export interface VisualTaskActions {
  onRename: (id: string) => void;
  onRemove: (id: string) => void;
  onViewSource: (id: string) => void;
}

/** The list's mounted rows, for a closing dialog that has to name where the keyboard goes. */
export interface VisualRowFocus {
  /** The row's button as mounted now. */
  rowElement: (id: string) => HTMLElement | null;
}

/** A workspace-level sentence that is not the list's own load failure. */
export interface VisualShellNotice {
  message: string;
  tone: "error" | "notice";
}

function shortcutChord(shortcut: VisualShortcut | undefined): string | undefined {
  return shortcut?.binding == null ? undefined : `${shortcut.prefix} ${shortcut.binding}`;
}

/**
 * One row's menu: copy and rename, then read-only context, then the destructive action. The source
 * item exists only when the task has a source; the branch item only when it has a branch.
 */
function TaskRowMenu({
  row,
  actions,
  renameShortcut,
  removeShortcut,
  onCopy,
}: {
  row: VisualTaskRow;
  actions: VisualTaskActions;
  renameShortcut: VisualShortcut | undefined;
  removeShortcut: VisualShortcut | undefined;
  onCopy: (text: string, copied: string) => void;
}) {
  const branch = row.copyBranch;
  const renameChord = shortcutChord(renameShortcut);
  const removeChord = shortcutChord(removeShortcut);
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Icon name="copy" />
          <span>Copy</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent skin="visual">
          <DropdownMenuItem
            icon="folder"
            aria-label="Copy workspace path"
            onClick={() => onCopy(row.workspacePath, "Workspace path copied")}
          >
            Path
          </DropdownMenuItem>
          {branch !== undefined && (
            <DropdownMenuItem
              icon="branch"
              aria-label="Copy branch"
              onClick={() => onCopy(branch, "Branch copied")}
            >
              Branch
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            icon="hash"
            aria-label="Copy task ID"
            onClick={() => onCopy(row.id, "Task ID copied")}
          >
            Task ID
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem
        icon="task"
        aria-keyshortcuts={renameChord}
        onClick={() => actions.onRename(row.id)}
      >
        Rename task…
        {renameChord !== undefined && (
          <DropdownMenuShortcut aria-hidden="true">{renameChord}</DropdownMenuShortcut>
        )}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {row.hasSource && (
        <DropdownMenuItem icon="source" onClick={() => actions.onViewSource(row.id)}>
          View issue source…
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        variant="destructive"
        icon="remove"
        onClick={() => actions.onRemove(row.id)}
      >
        Remove task…
        {removeChord !== undefined && (
          <DropdownMenuShortcut aria-hidden="true">{removeChord}</DropdownMenuShortcut>
        )}
      </DropdownMenuItem>
    </>
  );
}

export interface VisualShellViewProps {
  rows: readonly VisualTaskRow[];
  /** `null` means the user explicitly chose no task; `undefined` falls back to the first row. */
  selectedId: string | null | undefined;
  projectsLoaded: boolean;
  hasProjects?: boolean | undefined;
  tasksLoaded: boolean;
  failure: string | undefined;
  shortcut: VisualShortcut | undefined;
  onSelectTask: (id: string) => void;
  /** A real, safe path when the shell has one; absent in the review host. */
  onAddProject?: (() => void) | undefined;
  /** The main area's composer when a draft is open; otherwise the selected task or empty state. */
  main?: ReactNode | undefined;
  /** While a draft is open no sidebar row is current (`docs/ux.md`, **Layout**). */
  composerOpen?: boolean | undefined;
  onNewTask?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  /** The prefix action `new-task`/`settings`, for the button tooltips. */
  newTaskShortcut?: VisualShortcut | undefined;
  settingsShortcut?: VisualShortcut | undefined;
  /** Direct creation commands, already resolved from config; one listener handles all of them. */
  direct?: {
    bindings: Readonly<Record<DirectActionId, string | null>>;
    onAction: (action: DirectActionId) => void;
  };
  /** False while a dialog, Settings or an in-flight create owns the keyboard. */
  prefixEnabled?: boolean | undefined;
  /** A row's secondary actions; absent when this host has no task store to act on. */
  taskActions?: VisualTaskActions | undefined;
  /** The same effective bindings the task menu shows in its shortcut cells. */
  renameShortcut?: VisualShortcut | undefined;
  removeShortcut?: VisualShortcut | undefined;
  /** A failed action or guidance that is not the task list's own load failure. */
  notice?: VisualShellNotice | undefined;
  onDismissNotice?: (() => void) | undefined;
  /** The mounted rows, so a dialog closing after a removal can focus the row that takes over. */
  rowFocus?: Ref<VisualRowFocus> | undefined;
}

function SidebarList({
  rows,
  selectedId,
  projectsLoaded,
  hasProjects,
  tasksLoaded,
  failure,
  onSelectTask,
  taskActions,
  renameShortcut,
  removeShortcut,
  onCopy,
  onMenuOpen,
  rowFocus,
}: Pick<
  VisualShellViewProps,
  | "rows"
  | "selectedId"
  | "projectsLoaded"
  | "hasProjects"
  | "tasksLoaded"
  | "failure"
  | "onSelectTask"
  | "taskActions"
  | "renameShortcut"
  | "removeShortcut"
  | "rowFocus"
> & {
  onCopy: (text: string, copied: string) => void;
  onMenuOpen: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const selected =
    selectedId === null ? undefined : (rows.find((row) => row.id === selectedId) ?? rows[0]);

  const rowElement = useCallback((id: string) => {
    return list.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`) ?? null;
  }, []);
  const focusRow = useCallback(
    (id: string) => {
      requestAnimationFrame(() => rowElement(id)?.focus());
    },
    [rowElement],
  );
  // The selection path above owns `focusRow`; a closing dialog only needs the element itself.
  useImperativeHandle(rowFocus, () => ({ rowElement }), [rowElement]);

  const select = useCallback(
    (id: string) => {
      onSelectTask(id);
      focusRow(id);
    },
    [focusRow, onSelectTask],
  );

  const navigate = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return;
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + direction))];
      if (next !== undefined && next.id !== id) select(next.id);
    },
    [rows, select],
  );

  if (failure !== undefined) {
    return (
      <div className="visual-task-scroll visual-scrollbar">
        <div className="visual-list-state" role="alert">
          <span className="visual-list-state-title">The workspace could not load.</span>
          <span className="visual-list-state-detail">{failure}</span>
        </div>
      </div>
    );
  }
  if (!projectsLoaded || !tasksLoaded) {
    return (
      <div className="visual-task-scroll visual-scrollbar">
        <div className="visual-list-state" aria-live="polite">
          <span className="visual-list-state-title">Loading tasks…</span>
        </div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="visual-task-scroll visual-scrollbar">
        <div className="visual-list-state">
          <span className="visual-list-state-title">No active tasks.</span>
          <span className="visual-list-state-detail">
            {hasProjects
              ? "Start one with New task."
              : "Add a project, or start without one with New task."}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="visual-task-scroll visual-scrollbar" ref={list}>
      <ul className="visual-task-list" aria-label="Tasks">
        {rows.map((row) => (
          <li key={row.id}>
            <VisualTaskCard
              row={row}
              selected={selected?.id === row.id}
              onSelect={select}
              onNavigate={navigate}
              settleReason="Settle is not part of this visual slice and is not connected to the old stop-all action."
              menu={
                taskActions === undefined ? undefined : (
                  <TaskRowMenu
                    row={row}
                    actions={taskActions}
                    renameShortcut={renameShortcut}
                    removeShortcut={removeShortcut}
                    onCopy={onCopy}
                  />
                )
              }
              onMenuOpen={onMenuOpen}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusLine(row: VisualTaskRow): string | undefined {
  const status = row.status;
  if (status === undefined) return undefined;
  if (status.tone === "neutral") {
    return status.time === undefined ? undefined : `Last reported ${status.time} ago`;
  }
  if (status.tone === "working") return "Working · start time not available";
  return [status.label, status.time === undefined ? undefined : `${status.time} ago`]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

function TaskMain({ row }: { row: VisualTaskRow }) {
  const status = statusLine(row);
  return (
    <div className="visual-main-task">
      <span className="visual-main-eyebrow">
        {row.project}
        {row.metadata.branch !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            <Icon name="branch" size="row" />
            <span>{row.metadata.branch}</span>
            <span>recorded</span>
          </>
        )}
      </span>
      <h1 className="visual-main-title">{row.title}</h1>
      {row.status !== undefined && (
        <span className="visual-main-status" data-tone={row.status.tone}>
          {status}
        </span>
      )}
      {row.metadata.prompt !== undefined && (
        <p className="visual-main-prompt">{row.metadata.prompt}</p>
      )}
      <p className="visual-main-note">
        Workspace tab groups and the conversation are not part of this visual slice.
      </p>
    </div>
  );
}

function EmptyMain({
  rows,
  hasProjects,
  failure,
}: {
  rows: readonly VisualTaskRow[];
  hasProjects: boolean;
  failure: string | undefined;
}) {
  return (
    <div className="visual-main-empty">
      <span className="visual-main-empty-title">
        {failure !== undefined
          ? "The workspace could not load."
          : rows.length === 0
            ? "No active tasks."
            : "No task selected."}
      </span>
      <span>
        {failure !== undefined
          ? failure
          : rows.length === 0
            ? hasProjects
              ? "Start a task with New task."
              : "Add a project from the sidebar footer, or start a scratch task with New task."
            : "Choose a task in the sidebar."}
      </span>
    </div>
  );
}

/**
 * The whole shell's presentation. Production passes live store rows; the review host passes
 * fixtures through this same component, never through a copy of it.
 */
export function VisualShellView({
  rows,
  selectedId,
  projectsLoaded,
  hasProjects = false,
  tasksLoaded,
  failure,
  shortcut,
  onSelectTask,
  onAddProject,
  main,
  composerOpen = false,
  onNewTask,
  onOpenSettings,
  newTaskShortcut,
  settingsShortcut,
  direct,
  prefixEnabled = true,
  taskActions,
  renameShortcut,
  removeShortcut,
  notice,
  onDismissNotice,
  rowFocus,
}: VisualShellViewProps) {
  const pane = useVisualSidebarPane();
  const selected =
    selectedId === null ? undefined : (rows.find((row) => row.id === selectedId) ?? rows[0]);
  const [copyNotice, setCopyNotice] = useState<CopyOutcome>();
  const clearCopyNotice = useCallback(() => setCopyNotice(undefined), []);
  const copy = useCallback((text: string, copied: string) => {
    setCopyNotice(undefined);
    void copyText(text, copied).then(setCopyNotice);
  }, []);
  const selectTask = useCallback(
    (id: string) => {
      setCopyNotice(undefined);
      onSelectTask(id);
    },
    [onSelectTask],
  );
  const shownNotice: VisualShellNotice | undefined =
    copyNotice === undefined
      ? notice
      : {
          message: copyNotice.message,
          tone: copyNotice.outcome === "refused" ? "error" : "notice",
        };
  const shellRef = useRef<HTMLDivElement>(null);
  const sidebarFrame = useRef<HTMLElement>(null);
  const toggleLayer = useRef<HTMLDivElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const openToggleSlot = useRef<HTMLSpanElement>(null);
  const closedToggleSlot = useRef<HTMLSpanElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const keymap = useMemo(() => {
    const bindings: Record<string, string> = {};
    if (shortcut?.binding !== null && shortcut?.binding !== undefined)
      bindings[shortcut.binding] = "toggle-sidebar";
    if (newTaskShortcut?.binding !== null && newTaskShortcut?.binding !== undefined)
      bindings[newTaskShortcut.binding] = "new-task";
    if (settingsShortcut?.binding !== null && settingsShortcut?.binding !== undefined)
      bindings[settingsShortcut.binding] = "settings";
    if (taskActions !== undefined) {
      if (renameShortcut?.binding !== null && renameShortcut?.binding !== undefined)
        bindings[renameShortcut.binding] = "rename-task";
      if (removeShortcut?.binding !== null && removeShortcut?.binding !== undefined)
        bindings[removeShortcut.binding] = "remove-task";
    }
    const prefix =
      shortcut?.prefix ??
      newTaskShortcut?.prefix ??
      settingsShortcut?.prefix ??
      renameShortcut?.prefix ??
      removeShortcut?.prefix ??
      "alt+a";
    return createPrefixKeymap(prefix, bindings);
  }, [newTaskShortcut, removeShortcut, renameShortcut, settingsShortcut, shortcut, taskActions]);
  const directKeymap = useMemo(() => {
    if (direct === undefined) return undefined;
    const bindings: Record<string, DirectActionId> = {};
    for (const action of DirectActionId.options) {
      const chord = direct.bindings[action];
      if (chord !== null) bindings[chord] = action;
    }
    return createDirectKeymap<DirectActionId>(bindings, modifierPlatform());
  }, [direct]);
  const { hidden, toggle } = pane;

  // One toggle floats over both surfaces; its position is read from the sidebar's real width, so
  // the CSS transition is the only motion and the button follows the same progress every frame.
  const syncToggle = useCallback(() => {
    const shell = shellRef.current;
    const sidebar = sidebarFrame.current;
    const layer = toggleLayer.current;
    const openSlot = openToggleSlot.current;
    const closedSlot = closedToggleSlot.current;
    if (
      shell === null ||
      sidebar === null ||
      layer === null ||
      openSlot === null ||
      closedSlot === null
    ) {
      return;
    }
    const shellBox = shell.getBoundingClientRect();
    const sidebarWidth = sidebar.getBoundingClientRect().width;
    const openBox = openSlot.getBoundingClientRect();
    const closedBox = closedSlot.getBoundingClientRect();
    const progress = pane.width <= 0 ? 1 : Math.min(1, Math.max(0, 1 - sidebarWidth / pane.width));
    const openX = openBox.left - shellBox.left;
    const openY = openBox.top - shellBox.top;
    // The closed slot travels with main; remove the animated sidebar width to get its rest x.
    const closedX = closedBox.left - shellBox.left - sidebarWidth;
    const closedY = closedBox.top - shellBox.top;
    const x = openX + (closedX - openX) * progress;
    const y = openY + (closedY - openY) * progress;
    layer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, [pane.width]);

  useLayoutEffect(() => {
    syncToggle();
  });

  useLayoutEffect(() => {
    const sidebar = sidebarFrame.current;
    if (sidebar === null) return undefined;
    const observer = new ResizeObserver(syncToggle);
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [syncToggle]);

  const toggleSidebar = useCallback(() => {
    const willHide = !hidden;
    const focusWasInside = sidebarFrame.current?.contains(document.activeElement) === true;
    toggle();
    if (!willHide || !focusWasInside) return;
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
    pendingFocus.current = requestAnimationFrame(() => {
      pendingFocus.current = null;
      toggleButton.current?.focus();
    });
  }, [hidden, toggle]);
  // The composer is a view, not a selected row: its open state also silences row chords.
  const currentTaskId = composerOpen ? undefined : selected?.id;
  const runAction = useCallback(
    (action: string) => {
      if (action === "toggle-sidebar") toggleSidebar();
      else if (action === "new-task") onNewTask?.();
      else if (action === "settings") onOpenSettings?.();
      else if (currentTaskId === undefined) return;
      else if (action === "rename-task") taskActions?.onRename(currentTaskId);
      else if (action === "remove-task") taskActions?.onRemove(currentTaskId);
    },
    [currentTaskId, onNewTask, onOpenSettings, taskActions, toggleSidebar],
  );
  usePrefixMode(
    keymap,
    runAction,
    prefixEnabled,
    directKeymap === undefined || direct === undefined
      ? undefined
      : { keymap: directKeymap, onAction: direct.onAction },
  );

  useEffect(
    () => () => {
      if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
    },
    [],
  );

  return (
    <div
      className="visual-shell-screen"
      ref={shellRef}
      onPointerDownCapture={clearCopyNotice}
      onKeyDownCapture={clearCopyNotice}
    >
      <div className="visual-toggle-handoff" ref={toggleLayer}>
        <VisualIconButton
          label={pane.hidden ? "Show sidebar" : "Hide sidebar"}
          icon={pane.hidden ? "show-sidebar" : "hide-sidebar"}
          onClick={toggleSidebar}
          shortcut={shortcut}
          buttonRef={toggleButton}
          ariaExpanded={!pane.hidden}
          ariaControls="visual-sidebar"
        />
      </div>
      <VisualSidebar
        frameRef={sidebarFrame}
        width={pane.width}
        hidden={pane.hidden}
        resizing={pane.resizing}
        resize={
          !pane.hidden ? (
            <VisualResizeHandle
              width={pane.width}
              min={VISUAL_SIDEBAR_MIN_WIDTH}
              max={Math.min(VISUAL_SIDEBAR_MAX_WIDTH, pane.maxWidth)}
              onResize={pane.setWidth}
              onResizeStart={pane.beginResize}
              onResizeEnd={pane.endResize}
            />
          ) : undefined
        }
      >
        <div className="visual-sidebar-header">
          <span className="visual-wordmark">Corral</span>
          <span className="visual-toggle-slot" ref={openToggleSlot} aria-hidden="true" />
        </div>
        <div className="visual-sidebar-actions">
          <VisualSearchAction
            label="Search tasks…"
            disabledReason="Task search is not part of this visual slice."
          />
          <VisualIconButton
            label="New task"
            icon="add"
            onClick={onNewTask}
            shortcut={newTaskShortcut}
            disabledReason={
              onNewTask === undefined ? "Creating tasks is unavailable here." : undefined
            }
          />
        </div>
        <TooltipProvider>
          <SidebarList
            rows={rows}
            selectedId={currentTaskId ?? null}
            projectsLoaded={projectsLoaded}
            hasProjects={hasProjects}
            tasksLoaded={tasksLoaded}
            failure={failure}
            onSelectTask={selectTask}
            taskActions={taskActions}
            renameShortcut={renameShortcut}
            removeShortcut={removeShortcut}
            rowFocus={rowFocus}
            onCopy={copy}
            onMenuOpen={clearCopyNotice}
          />
        </TooltipProvider>
        {shownNotice !== undefined && (
          <div
            className="visual-shell-notice"
            data-tone={shownNotice.tone}
            role={shownNotice.tone === "error" ? "alert" : "status"}
          >
            <span className="visual-shell-notice-message">{shownNotice.message}</span>
            {(onDismissNotice !== undefined || copyNotice !== undefined) && (
              <VisualIconButton
                label="Dismiss status"
                icon="close"
                onClick={() => {
                  clearCopyNotice();
                  onDismissNotice?.();
                }}
              />
            )}
          </div>
        )}
        <div className="visual-sidebar-footer">
          <VisualIconButton
            label="Settings"
            icon="settings"
            onClick={onOpenSettings}
            shortcut={settingsShortcut}
            disabledReason={
              onOpenSettings === undefined ? "Settings is unavailable here." : undefined
            }
          />
          <VisualIconButton
            label="Add project"
            icon="add-project"
            onClick={onAddProject}
            disabledReason={
              onAddProject === undefined ? "Adding projects is unavailable here." : undefined
            }
          />
        </div>
      </VisualSidebar>
      <main className="visual-shell-main" aria-label="Workspace">
        <div className="visual-main-chrome">
          <span className="visual-toggle-slot" ref={closedToggleSlot} aria-hidden="true" />
        </div>
        <div className="visual-main-content">
          {main !== undefined ? (
            main
          ) : selected === undefined ? (
            <EmptyMain rows={rows} hasProjects={hasProjects} failure={failure} />
          ) : (
            <TaskMain row={selected} />
          )}
        </div>
      </main>
    </div>
  );
}
