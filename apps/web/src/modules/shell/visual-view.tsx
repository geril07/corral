import type { ConnectionState } from "@corral/client/connection-state";
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
  type RefObject,
} from "react";
import { copyText, type CopyOutcome } from "../../common/lib/clipboard.ts";
import {
  Button,
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
  VisualShelfToggle,
  VisualSidebar,
  VisualTaskCard,
  type VisualShortcut,
  type VisualTaskRow,
} from "../../common/ui/index.ts";
import { ConnectionBanner } from "../connection/index.ts";
import { modifierPlatform, usePrefixMode } from "../keymap/index.ts";
import { ShellStatus } from "../workspace/index.ts";
import {
  useVisualSidebarPane,
  VISUAL_SIDEBAR_MAX_WIDTH,
  VISUAL_SIDEBAR_MIN_WIDTH,
} from "./sidebar-pane.ts";
import { useSettledShelf } from "./settled-shelf.ts";

/** What a row's secondary actions do; every one reaches a real surface in the production host. */
export interface VisualTaskActions {
  onRename: (id: string) => void;
  onRemove: (id: string) => void;
  onViewSource: (id: string) => void;
  /**
   * Settle an active task, or continue a settled one; the server stops or resumes its sessions.
   * Resolves true only when the server changed the state, false when it refused or nothing moved.
   * Absent in a host with no task store, which then offers no settle control at all.
   */
  onToggleSettle?: ((id: string) => Promise<boolean>) | undefined;
}

/** The list's mounted rows, for a closing dialog that has to name where the keyboard goes. */
export interface VisualRowFocus {
  /** The row's button as mounted now. */
  rowElement: (id: string) => HTMLElement | null;
  /**
   * What takes the keyboard when the working area empties: its selected tab, else any tab, else
   * the selected row, else New task, else the sidebar toggle. Never `null` while the shell is
   * mounted, so focus never falls to `<body>`.
   */
  fallbackElement: () => HTMLElement | null;
}

/** A workspace-level sentence that is not the list's own load failure. */
export interface VisualShellNotice {
  message: string;
  tone: "error" | "notice";
  /** One recoverable action, as T3's undo notice carries; it lives only in this notice. */
  action?: { label: string; run: () => void } | undefined;
}

function shortcutChord(shortcut: VisualShortcut | undefined): string | undefined {
  return shortcut?.binding == null ? undefined : `${shortcut.prefix} ${shortcut.binding}`;
}

/**
 * One row's menu: copy and rename, then state, then read-only context, then the destructive
 * action. The source item exists only when the task has a source; the branch item only when it has
 * a branch; settle only when the host has a task store.
 */
function TaskRowMenu({
  row,
  actions,
  onToggleSettle,
  renameShortcut,
  removeShortcut,
  settleShortcut,
  onCopy,
}: {
  row: VisualTaskRow;
  actions: VisualTaskActions;
  /** Row-originated settle, so the moved row's new home can take the keyboard back. */
  onToggleSettle: ((id: string) => void) | undefined;
  renameShortcut: VisualShortcut | undefined;
  removeShortcut: VisualShortcut | undefined;
  settleShortcut: VisualShortcut | undefined;
  onCopy: (text: string, copied: string) => void;
}) {
  const branch = row.copyBranch;
  const renameChord = shortcutChord(renameShortcut);
  const removeChord = shortcutChord(removeShortcut);
  const settleChord = shortcutChord(settleShortcut);
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
      {onToggleSettle !== undefined && (
        <DropdownMenuItem
          icon={row.settled === true ? "unsettle" : "settle"}
          aria-keyshortcuts={settleChord}
          onClick={() => onToggleSettle(row.id)}
        >
          {row.settled === true ? "Unsettle task" : "Settle task"}
          {settleChord !== undefined && (
            <DropdownMenuShortcut aria-hidden="true">{settleChord}</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
      )}
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

/** The shelf's disclosure as one keyboard stop; task ids are UUIDs, so no row can take the name. */
const SHELF_STOP = "shelf";

/** No settled rows, as one stable value: an inline `[]` default would change on every render. */
const NO_SETTLED_ROWS: readonly VisualTaskRow[] = [];

export interface VisualShellViewProps {
  rows: readonly VisualTaskRow[];
  /**
   * The Settled shelf's rows across every project, newest activity first. Empty hides the shelf;
   * the state itself is the server's `Task.state`, never a client fact.
   */
  settledRows?: readonly VisualTaskRow[] | undefined;
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
  /** The task's identity row above the strip: title, project, branch, status. */
  taskHeader?: ReactNode | undefined;
  /** One line above the whole working area: a refused action, never a tab-local error. */
  workingNotice?: ReactNode | undefined;
  /** The task's main tab strip, inside the 40 px chrome band. */
  chrome?: ReactNode | undefined;
  /** The companion group's column; it keeps its own strip and pane. */
  companion?: ReactNode | undefined;
  /** The working area owns its pane's padding; empty states keep the content inset. */
  mainFill?: boolean | undefined;
  /** While a draft is open no sidebar row is current (`docs/layout.md`). */
  composerOpen?: boolean | undefined;
  onNewTask?: (() => void) | undefined;
  /** Opens task search; absent in a host that cannot show the dialog. */
  onFindTask?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  /** The prefix action `new-task`/`find-task`/`settings`/`add-project`, for tooltips and keymap. */
  newTaskShortcut?: VisualShortcut | undefined;
  findTaskShortcut?: VisualShortcut | undefined;
  settingsShortcut?: VisualShortcut | undefined;
  addProjectShortcut?: VisualShortcut | undefined;
  /** `prefix w`: the list takes the keyboard; `prefix d`: settle or unsettle the current task. */
  focusSidebarShortcut?: VisualShortcut | undefined;
  settleShortcut?: VisualShortcut | undefined;
  /** Direct creation commands, already resolved from config; one listener handles all of them. */
  direct?: {
    bindings: Readonly<Record<DirectActionId, string | null>>;
    onAction: (action: DirectActionId) => void;
  };
  /** The working area's prefix actions, merged into the shell's one prefix listener. */
  prefixExtra?:
    | {
        bindings: Readonly<Record<string, string>>;
        onAction: (action: string) => void;
      }
    | undefined;
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
  /**
   * The live connection banner and its recovery surfaces. Absent in the fixture host, which keeps
   * the local notice row instead of mounting a status the review fixtures cannot drive.
   */
  status?:
    | {
        connection: ConnectionState;
        onOpenConnection: (opener: HTMLElement) => void;
        /** Retries the socket now; the desktop bridge also re-reads its endpoint file. */
        onRetryConnection: () => void;
        onOpenConfigProblems: (opener?: HTMLElement) => void;
      }
    | undefined;
  /** The mounted rows, so a dialog closing after a removal can focus the row that takes over. */
  rowFocus?: Ref<VisualRowFocus> | undefined;
}

function SidebarList({
  rows,
  projectsLoaded,
  hasProjects,
  tasksLoaded,
  failure,
  renderRow,
  shelf,
}: Pick<
  VisualShellViewProps,
  "rows" | "projectsLoaded" | "hasProjects" | "tasksLoaded" | "failure"
> & {
  renderRow: (row: VisualTaskRow) => ReactNode;
  /** The Settled shelf: the same scroller, so the sidebar stays one scrolling region. */
  shelf?: ReactNode | undefined;
}) {
  if (failure !== undefined) {
    return (
      <div className="visual-task-scroll">
        <div className="visual-list-state" role="alert">
          <span className="visual-list-state-title">The workspace could not load.</span>
          <span className="visual-list-state-detail">{failure}</span>
        </div>
      </div>
    );
  }
  if (!projectsLoaded || !tasksLoaded) {
    return (
      <div className="visual-task-scroll">
        <div className="visual-list-state" aria-live="polite">
          <span className="visual-list-state-title">Loading tasks…</span>
        </div>
      </div>
    );
  }
  return (
    <div className="visual-task-scroll">
      {rows.length === 0 ? (
        <div className="visual-list-state">
          <span className="visual-list-state-title">No active tasks.</span>
          <span className="visual-list-state-detail">
            {hasProjects
              ? "Start one with New task."
              : "Add a project, or start without one with New task."}
          </span>
        </div>
      ) : (
        <ul className="visual-task-list" aria-label="Tasks">
          {rows.map(renderRow)}
        </ul>
      )}
      {shelf}
    </div>
  );
}

/** The settled list's one id, so the disclosure's expanded state names the list it opens. */
const SETTLED_LIST_ID = "visual-settled-list";

/**
 * The settled tasks below the active list (`design.md`, **Domain model** — Task): one collapsed
 * group, the count in its label, and the same card rows as the active list. Collapsed, it keeps
 * the current task's row alone, so closing the shelf never hides what the main area shows.
 */
function SettledShelf({
  rows,
  shown,
  expanded,
  onToggle,
  onStep,
  toggleRef,
  renderRow,
}: {
  rows: readonly VisualTaskRow[];
  /** The rows mounted now: all of them expanded, the current one alone collapsed. */
  shown: readonly VisualTaskRow[];
  expanded: boolean;
  onToggle: () => void;
  /** An arrow from the toggle: the next stop in the sidebar's order. */
  onStep: (direction: -1 | 1) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  renderRow: (row: VisualTaskRow) => ReactNode;
}) {
  return (
    <div className="visual-shelf">
      <VisualShelfToggle
        label={`Settled (${rows.length})`}
        expanded={expanded}
        ariaControls={SETTLED_LIST_ID}
        onToggle={onToggle}
        onStep={onStep}
        buttonRef={toggleRef}
      />
      {/* Always mounted, so the disclosure's `aria-controls` names a real list in every state. */}
      <ul id={SETTLED_LIST_ID} className="visual-task-list" aria-label="Settled tasks">
        {shown.map(renderRow)}
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

export function TaskMain({
  row,
  compact = false,
}: {
  row: VisualTaskRow;
  /** The working area's one-line header; the review host keeps the full block. */
  compact?: boolean;
}) {
  const status = statusLine(row);
  return (
    <div className={compact ? "visual-main-task visual-main-task-compact" : "visual-main-task"}>
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
      {row.settled === true && <span className="visual-main-settled">Settled</span>}
      {!compact && row.metadata.prompt !== undefined && (
        <p className="visual-main-prompt">{row.metadata.prompt}</p>
      )}
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
  settledRows: settled = NO_SETTLED_ROWS,
  selectedId,
  projectsLoaded,
  hasProjects = false,
  tasksLoaded,
  failure,
  shortcut,
  onSelectTask,
  onAddProject,
  main,
  taskHeader,
  workingNotice,
  chrome,
  companion,
  mainFill = false,
  composerOpen = false,
  onNewTask,
  onFindTask,
  onOpenSettings,
  newTaskShortcut,
  findTaskShortcut,
  settingsShortcut,
  addProjectShortcut,
  focusSidebarShortcut,
  settleShortcut,
  direct,
  prefixExtra,
  prefixEnabled = true,
  taskActions,
  renameShortcut,
  removeShortcut,
  notice,
  onDismissNotice,
  rowFocus,
  status,
}: VisualShellViewProps) {
  const pane = useVisualSidebarPane();
  const shelf = useSettledShelf();
  // The selection may name a settled task: the shelf is part of the one list, so a settled row is
  // found before the fallback to the first active one.
  const selected =
    selectedId === null
      ? undefined
      : ([...rows, ...settled].find((row) => row.id === selectedId) ?? rows[0]);
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
  const mainRef = useRef<HTMLElement>(null);
  const newTaskButton = useRef<HTMLButtonElement>(null);
  const sidebarFrame = useRef<HTMLElement>(null);
  const shelfToggle = useRef<HTMLButtonElement>(null);
  const toggleLayer = useRef<HTMLDivElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const openToggleSlot = useRef<HTMLSpanElement>(null);
  const closedToggleSlot = useRef<HTMLSpanElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const settleFocus = useRef<{ id: string; settled: boolean } | undefined>(undefined);
  // One transient-state clear for both: the copy confirmation and a settle's focus intent end on
  // the user's next input, so neither can act after the user has moved on.
  const clearTransient = useCallback(() => {
    setCopyNotice(undefined);
    settleFocus.current = undefined;
  }, []);
  const prefix =
    shortcut?.prefix ??
    newTaskShortcut?.prefix ??
    findTaskShortcut?.prefix ??
    settingsShortcut?.prefix ??
    renameShortcut?.prefix ??
    removeShortcut?.prefix ??
    "alt+a";
  const keymap = useMemo(() => {
    const bindings: Record<string, string> = {};
    if (shortcut?.binding !== null && shortcut?.binding !== undefined)
      bindings[shortcut.binding] = "toggle-sidebar";
    if (newTaskShortcut?.binding !== null && newTaskShortcut?.binding !== undefined)
      bindings[newTaskShortcut.binding] = "new-task";
    if (
      onFindTask !== undefined &&
      findTaskShortcut?.binding !== null &&
      findTaskShortcut?.binding !== undefined
    )
      bindings[findTaskShortcut.binding] = "find-task";
    if (settingsShortcut?.binding !== null && settingsShortcut?.binding !== undefined)
      bindings[settingsShortcut.binding] = "settings";
    if (focusSidebarShortcut?.binding !== null && focusSidebarShortcut?.binding !== undefined)
      bindings[focusSidebarShortcut.binding] = "focus-sidebar";
    if (taskActions !== undefined) {
      if (renameShortcut?.binding !== null && renameShortcut?.binding !== undefined)
        bindings[renameShortcut.binding] = "rename-task";
      if (removeShortcut?.binding !== null && removeShortcut?.binding !== undefined)
        bindings[removeShortcut.binding] = "remove-task";
    }
    if (taskActions?.onToggleSettle !== undefined) {
      if (settleShortcut?.binding !== null && settleShortcut?.binding !== undefined)
        bindings[settleShortcut.binding] = "settle-task";
    }
    if (addProjectShortcut?.binding !== null && addProjectShortcut?.binding !== undefined)
      bindings[addProjectShortcut.binding] = "add-project";
    if (prefixExtra !== undefined) {
      for (const [chord, action] of Object.entries(prefixExtra.bindings)) {
        bindings[chord] = action;
      }
    }
    return createPrefixKeymap(prefix, bindings);
  }, [
    addProjectShortcut,
    findTaskShortcut,
    focusSidebarShortcut,
    newTaskShortcut,
    onFindTask,
    prefix,
    prefixExtra,
    removeShortcut,
    renameShortcut,
    settingsShortcut,
    settleShortcut,
    shortcut,
    taskActions,
  ]);
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

  // The sidebar frame, not the scroller: a settled row lives in the shelf below the active list.
  const rowElement = useCallback(
    (id: string) =>
      sidebarFrame.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`) ??
      null,
    [],
  );
  const focusRow = useCallback(
    (id: string) => {
      requestAnimationFrame(() => rowElement(id)?.focus());
    },
    [rowElement],
  );
  const selectRow = useCallback(
    (id: string) => {
      selectTask(id);
      focusRow(id);
    },
    [focusRow, selectTask],
  );
  // The composer is a view, not a selected row: its open state also silences row chords.
  const currentTaskId = composerOpen ? undefined : selected?.id;
  // What the shelf mounts: every settled row when open, the current one alone when closed.
  const currentSettled = settled.find((row) => row.id === currentTaskId);
  const shownSettled = useMemo(
    () => (shelf.expanded ? settled : currentSettled === undefined ? [] : [currentSettled]),
    [currentSettled, settled, shelf.expanded],
  );
  // Navigation and the settle intent read the rows as they are *now*, through refs, so their
  // callbacks stay one identity across a status tick instead of re-rendering every mounted card.
  const rowsRef = useRef(rows);
  const settledRef = useRef(settled);
  const shownSettledRef = useRef(shownSettled);
  useLayoutEffect(() => {
    rowsRef.current = rows;
    settledRef.current = settled;
    shownSettledRef.current = shownSettled;
  }, [rows, settled, shownSettled]);
  // Every keyboard stop in the sidebar's order: the active cards, the shelf toggle, its rows.
  const navigate = useCallback(
    (from: string, direction: -1 | 1) => {
      const stops = rowsRef.current.map((row) => row.id);
      if (settledRef.current.length > 0) {
        stops.push(SHELF_STOP);
        for (const row of shownSettledRef.current) stops.push(row.id);
      }
      const index = stops.indexOf(from);
      if (index === -1) return;
      const next = stops[Math.min(stops.length - 1, Math.max(0, index + direction))];
      if (next === undefined || next === from) return;
      if (next === SHELF_STOP) {
        shelfToggle.current?.focus();
        return;
      }
      selectRow(next);
    },
    [selectRow],
  );
  const settle = taskActions?.onToggleSettle;
  // The intent lives only until the user does something else or the row moves: a settle that
  // reports success without moving (the server already had the state) must not take the keyboard
  // back when another window's watch lands later.
  const dropSettleFocus = useCallback(() => {
    settleFocus.current = undefined;
  }, []);
  // Every row-originated settle: the row is about to move between two lists and remount, so its
  // new home takes the keyboard back. A menu item lives in a portal, so this path cannot ask
  // whether the sidebar held focus; `prefix d` asks that in `toggleSettle`.
  const settleRow = useCallback(
    (id: string) => {
      if (settle === undefined) return;
      settleFocus.current = { id, settled: settledRef.current.some((row) => row.id === id) };
      void settle(id).then(
        (accepted) => {
          // False means the server refused it or nothing moved; either way there is nothing to
          // hand the keyboard back to.
          if (!accepted && settleFocus.current?.id === id) dropSettleFocus();
        },
        () => {
          if (settleFocus.current?.id === id) dropSettleFocus();
        },
      );
    },
    [dropSettleFocus, settle],
  );
  const toggleSettle = useCallback(
    (id: string) => {
      if (settle === undefined) return;
      if (sidebarFrame.current?.contains(document.activeElement) === true) {
        settleRow(id);
        return;
      }
      // `prefix d` from the terminal or the main area: the row moves, the keyboard stays put.
      void settle(id);
    },
    [settle, settleRow],
  );
  useLayoutEffect(() => {
    const pending = settleFocus.current;
    if (pending === undefined) return;
    const home = settled.some((row) => row.id === pending.id);
    if (home === pending.settled) return;
    dropSettleFocus();
    const row = rowElement(pending.id);
    // The row went into a collapsed shelf and is not mounted: its disclosure now names it.
    if (row !== null) row.focus();
    else if (home) shelfToggle.current?.focus();
  }, [dropSettleFocus, rowElement, settled]);
  // A selection that arrives from outside the sidebar (a `?task=` URL on load) is not a focus
  // change, so the shelf has to reveal its current row the way the prior shelf did.
  useLayoutEffect(() => {
    if (currentTaskId === undefined) return;
    rowElement(currentTaskId)?.scrollIntoView({ block: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- opening the shelf is the trigger
  }, [currentTaskId, rowElement, shelf.expanded]);
  const focusList = useCallback(() => {
    if (hidden) toggle();
    requestAnimationFrame(() => {
      const target =
        (currentTaskId === undefined ? null : rowElement(currentTaskId)) ??
        (rows[0] === undefined ? null : rowElement(rows[0].id)) ??
        shelfToggle.current ??
        newTaskButton.current;
      target?.focus();
    });
  }, [currentTaskId, hidden, rowElement, rows, toggle]);
  // One handle for the mounted rows and for the keyboard's landing place when the working area
  // empties; the caller never searches the document.
  const fallbackElement = useCallback(() => {
    const area = mainRef.current;
    const tab =
      area?.querySelector<HTMLElement>('[data-tab-id][aria-selected="true"]') ??
      area?.querySelector<HTMLElement>("[data-tab-id]");
    if (tab !== null && tab !== undefined) return tab;
    // A hidden sidebar is inert, so its buttons cannot take focus.
    if (!hidden) {
      const row = selected === undefined ? null : rowElement(selected.id);
      if (row !== null) return row;
      const first = rows[0];
      const firstRow = first === undefined ? null : rowElement(first.id);
      if (firstRow !== null) return firstRow;
      return newTaskButton.current;
    }
    return toggleButton.current;
  }, [hidden, rowElement, rows, selected]);
  useImperativeHandle(rowFocus, () => ({ rowElement, fallbackElement }), [
    fallbackElement,
    rowElement,
  ]);

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
  const runAction = useCallback(
    (action: string) => {
      if (action === "toggle-sidebar") toggleSidebar();
      else if (action === "new-task") onNewTask?.();
      else if (action === "find-task") onFindTask?.();
      else if (action === "settings") onOpenSettings?.();
      else if (action === "add-project") onAddProject?.();
      else if (action === "focus-sidebar") focusList();
      else if (action === "rename-task" || action === "remove-task" || action === "settle-task") {
        if (currentTaskId === undefined) return;
        if (action === "rename-task") taskActions?.onRename(currentTaskId);
        else if (action === "remove-task") taskActions?.onRemove(currentTaskId);
        else toggleSettle(currentTaskId);
      } else prefixExtra?.onAction(action);
    },
    [
      currentTaskId,
      focusList,
      onAddProject,
      onFindTask,
      onNewTask,
      onOpenSettings,
      prefixExtra,
      taskActions,
      toggleSidebar,
      toggleSettle,
    ],
  );
  const armed = usePrefixMode(
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

  // One card recipe for both lists: the active list and the shelf differ in their group, not in
  // their row.
  const renderRow = useCallback(
    (row: VisualTaskRow) => (
      <li key={row.id}>
        <VisualTaskCard
          row={row}
          selected={currentTaskId === row.id}
          onSelect={selectRow}
          onNavigate={navigate}
          onToggleSettle={settle === undefined ? undefined : () => settleRow(row.id)}
          menu={
            taskActions === undefined ? undefined : (
              <TaskRowMenu
                row={row}
                actions={taskActions}
                onToggleSettle={settle === undefined ? undefined : settleRow}
                renameShortcut={renameShortcut}
                removeShortcut={removeShortcut}
                settleShortcut={settleShortcut}
                onCopy={copy}
              />
            )
          }
          onMenuOpen={clearCopyNotice}
        />
      </li>
    ),
    [
      clearCopyNotice,
      copy,
      currentTaskId,
      navigate,
      removeShortcut,
      renameShortcut,
      selectRow,
      settle,
      settleRow,
      settleShortcut,
      taskActions,
    ],
  );
  const shelfElement =
    settled.length === 0 ? undefined : (
      <SettledShelf
        rows={settled}
        shown={shownSettled}
        expanded={shelf.expanded}
        onToggle={shelf.toggle}
        onStep={(direction) => navigate(SHELF_STOP, direction)}
        toggleRef={shelfToggle}
        renderRow={renderRow}
      />
    );

  return (
    <div
      className="visual-shell-screen"
      ref={shellRef}
      onPointerDownCapture={clearTransient}
      onKeyDownCapture={clearTransient}
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
          {onFindTask !== undefined && (
            <VisualSearchAction
              label="Search tasks…"
              shortcut={findTaskShortcut}
              onClick={onFindTask}
            />
          )}
          <VisualIconButton
            label="New task"
            icon="add"
            onClick={onNewTask}
            shortcut={newTaskShortcut}
            buttonRef={newTaskButton}
            disabledReason={
              onNewTask === undefined ? "Creating tasks is unavailable here." : undefined
            }
          />
        </div>
        <TooltipProvider>
          <SidebarList
            rows={rows}
            projectsLoaded={projectsLoaded}
            hasProjects={hasProjects}
            tasksLoaded={tasksLoaded}
            failure={failure}
            renderRow={renderRow}
            shelf={shelfElement}
          />
        </TooltipProvider>
        {status === undefined && shownNotice !== undefined && (
          <div
            className="visual-shell-notice"
            data-tone={shownNotice.tone}
            role={shownNotice.tone === "error" ? "alert" : "status"}
          >
            <span className="visual-shell-notice-message">{shownNotice.message}</span>
            {shownNotice.action !== undefined && (
              <Button variant="ghost" size="xs" onClick={shownNotice.action.run}>
                {shownNotice.action.label}
              </Button>
            )}
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
        {status === undefined ? (
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
              shortcut={addProjectShortcut}
              disabledReason={
                onAddProject === undefined ? "Adding projects is unavailable here." : undefined
              }
            />
          </div>
        ) : !hidden ? (
          <ShellStatus
            placement="footer"
            armed={armed}
            prefix={prefix}
            failure={shownNotice}
            onDismissFailure={() => {
              clearCopyNotice();
              onDismissNotice?.();
            }}
            onOpenConfigProblems={status.onOpenConfigProblems}
            actions={
              <>
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
                  shortcut={addProjectShortcut}
                  disabledReason={
                    onAddProject === undefined ? "Adding projects is unavailable here." : undefined
                  }
                />
              </>
            }
          />
        ) : null}
      </VisualSidebar>
      <main className="visual-shell-main" aria-label="Workspace" ref={mainRef}>
        {status !== undefined && (
          <ConnectionBanner
            state={status.connection}
            onOpenDetails={status.onOpenConnection}
            onRetry={status.onRetryConnection}
          />
        )}
        {hidden && status !== undefined && (
          <ShellStatus
            placement="strip"
            armed={armed}
            prefix={prefix}
            failure={shownNotice}
            onDismissFailure={() => {
              clearCopyNotice();
              onDismissNotice?.();
            }}
            onOpenConfigProblems={status.onOpenConfigProblems}
          />
        )}
        {taskHeader !== undefined && (
          <div className="visual-task-header">
            <span
              className={
                pane.hidden
                  ? "visual-toggle-slot"
                  : "visual-toggle-slot visual-toggle-slot-collapsed"
              }
              ref={closedToggleSlot}
              aria-hidden="true"
            />
            {taskHeader}
          </div>
        )}
        {workingNotice}
        {(taskHeader === undefined || chrome !== undefined) && (
          <div className="visual-main-chrome">
            {taskHeader === undefined && (
              <span
                className={
                  pane.hidden
                    ? "visual-toggle-slot"
                    : "visual-toggle-slot visual-toggle-slot-collapsed"
                }
                ref={closedToggleSlot}
                aria-hidden="true"
              />
            )}
            {chrome}
          </div>
        )}
        <div className="visual-workspace-body">
          <div
            className={
              mainFill ? "visual-main-content visual-main-content-fill" : "visual-main-content"
            }
          >
            {main !== undefined ? (
              main
            ) : selected === undefined ? (
              <EmptyMain rows={rows} hasProjects={hasProjects} failure={failure} />
            ) : (
              <TaskMain row={selected} />
            )}
          </div>
          {companion}
        </div>
      </main>
    </div>
  );
}
