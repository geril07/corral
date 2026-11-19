import type { ConnectionState } from "@corral/client/connection-state";
import { createDirectKeymap, createPrefixKeymap } from "@corral/client/prefix-keymap";
import { resolveSnoozeChoices } from "@corral/client/snooze";
import { stepActive } from "@corral/client/terminal-selection";
import { ActionId, DirectActionId, type SnoozePreset } from "@corral/protocol/config";
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
import { copyText } from "../../common/lib/clipboard.ts";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  Icon,
  TooltipProvider,
  toast,
  useDialogFocus,
  VisualIconButton,
  VisualResizeHandle,
  VisualSearchAction,
  VisualShelfMore,
  VisualShelfToggle,
  VisualSidebar,
  VisualTaskCard,
  type VisualShortcut,
  type VisualTaskRow,
} from "../../common/ui/index.ts";
import { ConnectionBanner } from "../connection/index.ts";
import {
  ACTION_GROUP_OF,
  ACTION_LABELS,
  actionAvailability,
  CommandPaletteDialog,
  modifierPlatform,
  usePausedPalette,
  usePrefixMode,
  type ActionAvailability,
  type ActionEntry,
  type ActionTable,
} from "../keymap/index.ts";
import { ShellStatus } from "../workspace/index.ts";
import {
  useVisualSidebarPane,
  VISUAL_SIDEBAR_MAX_WIDTH,
  VISUAL_SIDEBAR_MIN_WIDTH,
} from "./sidebar-pane.ts";
import { useSettledShelf, useSnoozedShelf } from "./shelves.ts";

/**
 * What a snooze write reported. A refusal carries the server's sentence, so the custom dialog can
 * keep it on screen instead of closing onto a notice the user cannot see.
 */
export interface SnoozeOutcome {
  accepted: boolean;
  message?: string | undefined;
}

/** What a row's secondary actions do; every one reaches a real surface in the production host. */
export interface VisualTaskActions {
  onRename: (id: string) => void;
  onRemove: (id: string) => void;
  onViewSource: (id: string) => void;
  /**
   * Settle an active task, or return a settled one to the active list, without changing sessions.
   * Resolves true only when the server changed the state, false when it refused or nothing moved.
   * Absent in a host with no task store, which then offers no settle control at all.
   */
  onToggleSettle?: ((id: string) => Promise<boolean>) | undefined;
  /**
   * Leaves the task off the active list until `snoozedUntil` (epoch ms), sessions untouched.
   * `accepted` is true only when the server wrote it; a refusal carries the sentence to show.
   */
  onSnooze?: ((id: string, snoozedUntil: number) => Promise<SnoozeOutcome>) | undefined;
  /** Ends a snooze now. Resolves true only when the server wrote it. */
  onUnsnooze?: ((id: string) => Promise<boolean>) | undefined;
  /** Opens the custom wake-time dialog for the task. */
  onSnoozeCustom?: ((id: string) => void) | undefined;
  /** Clears a `Woke` notice by recording that the user has looked at the task. */
  onAcknowledgeWoke?: ((id: string) => void) | undefined;
}

/** The list's mounted rows, for a closing dialog that has to name where the keyboard goes. */
export interface VisualRowFocus {
  /** The row's button as mounted now. */
  rowElement: (id: string) => HTMLElement | null;
  /**
   * Snoozes the row with the same selection handoff as the row menu, so the custom dialog writes
   * through one path and can keep a refusal on screen.
   */
  snooze: (id: string, snoozedUntil: number) => Promise<SnoozeOutcome>;
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
  onSnooze,
  onUnsnooze,
  onSnoozeCustom,
  snoozePresets,
  now,
  renameShortcut,
  removeShortcut,
  settleShortcut,
  onCopy,
}: {
  row: VisualTaskRow;
  actions: VisualTaskActions;
  /** Row-originated settle, so the moved row's new home can take the keyboard back. */
  onToggleSettle: ((id: string) => void) | undefined;
  onSnooze: ((id: string, snoozedUntil: number) => void) | undefined;
  onUnsnooze: ((id: string) => void) | undefined;
  onSnoozeCustom: ((id: string) => void) | undefined;
  /** The wake times the menu offers, from the server's config. */
  snoozePresets: readonly SnoozePreset[];
  /** The shell's clock: a duration counts from here, so the choices need no clock of their own. */
  now: number;
  renameShortcut: VisualShortcut | undefined;
  removeShortcut: VisualShortcut | undefined;
  settleShortcut: VisualShortcut | undefined;
  onCopy: (text: string, copied: string) => void;
}) {
  const branch = row.copyBranch;
  const renameChord = shortcutChord(renameShortcut);
  const removeChord = shortcutChord(removeShortcut);
  const settleChord = shortcutChord(settleShortcut);
  // Resolved from the shell's clock, so a duration counts from the time on screen rather than
  // from a Date the menu would read during render.
  const snoozeChoices = useMemo(
    () => (onSnooze === undefined ? [] : resolveSnoozeChoices(snoozePresets, new Date(now))),
    [now, onSnooze, snoozePresets],
  );
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
      {onSnooze !== undefined &&
        onUnsnooze !== undefined &&
        row.settled !== true &&
        (row.snoozed === true ? (
          <DropdownMenuItem icon="clock" onClick={() => onUnsnooze(row.id)}>
            Wake task
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={row.canSnooze === false}>
              <Icon name="clock" />
              <span>Snooze</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent skin="visual">
              {snoozeChoices.map((choice) => (
                <DropdownMenuItem key={choice.id} onClick={() => onSnooze(row.id, choice.until)}>
                  {`${choice.label} (${choice.when})`}
                </DropdownMenuItem>
              ))}
              {onSnoozeCustom !== undefined && (
                <DropdownMenuItem onClick={() => onSnoozeCustom(row.id)}>Custom…</DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
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

/** Each shelf's disclosure and Show more row are one keyboard stop; ids are UUIDs, so none clash. */
const SNOOZE_SHELF_STOP = "snooze-shelf";
const SNOOZE_SHELF_MORE_STOP = "snooze-shelf-more";
const SETTLED_SHELF_STOP = "settled-shelf";
const SETTLED_SHELF_MORE_STOP = "settled-shelf-more";

/** Rows an open shelf mounts at first, and the step each Show more adds. */
const SHELF_INITIAL_COUNT = 10;
const SHELF_PAGE_COUNT = 25;

/** Where a row can live in the sidebar: the active list, or one of the two shelves. */
type RowHome = "active" | "snoozed" | "settled";

/** No rows, as one stable value: an inline `[]` default would change on every render. */
const NO_ROWS: readonly VisualTaskRow[] = [];
/** No presets, for a host without a config: the menu then shows only Custom…. */
const NO_SNOOZE_PRESETS: readonly SnoozePreset[] = [];

/** How long one copy confirmation stays; each copy raises its own, so they stack at the corner. */
const COPY_TOAST_MS = 3000;

export interface VisualShellViewProps {
  rows: readonly VisualTaskRow[];
  /**
   * The Settled shelf's rows across every project, newest activity first. Empty hides the shelf;
   * the state itself is the server's `Task.state`, never a client fact.
   */
  settledRows?: readonly VisualTaskRow[] | undefined;
  /**
   * The Snoozed shelf's rows across every project, soonest wake first. Empty hides the shelf; the
   * wake time is the server's, and whether it applies now is the wake rule's answer.
   */
  snoozedRows?: readonly VisualTaskRow[] | undefined;
  /** The wake times the row menu offers, from the server's `[snooze]` config. */
  snoozePresets?: readonly SnoozePreset[] | undefined;
  /** The shell's clock, which the snooze menu resolves its choices against. */
  snoozeNow?: number | undefined;
  /** `null` means the user explicitly chose no task; `undefined` falls back to the first row. */
  selectedId: string | null | undefined;
  projectsLoaded: boolean;
  hasProjects?: boolean | undefined;
  tasksLoaded: boolean;
  failure: string | undefined;
  shortcut: VisualShortcut | undefined;
  /** `null` clears the selection, as a snoozed current row does when no other row is left. */
  onSelectTask: (id: string | null) => void;
  /** A real, safe path when the shell has one; absent in the review host. */
  onAddProject?: (() => void) | undefined;
  /** The main area's composer when a draft is open; otherwise the selected task or empty state. */
  main?: ReactNode | undefined;
  /** The task's identity row above the strip: project and title, never live state. */
  taskHeader?: ReactNode | undefined;
  /** One line above the whole working area: a refused action, never a tab-local error. */
  workingNotice?: ReactNode | undefined;
  /** The task's main tab strip, inside the 40 px chrome band. */
  chrome?: ReactNode | undefined;
  /** The companion group's column; it keeps its own strip and pane. */
  companion?: ReactNode | undefined;
  /** The working area owns its pane's padding; empty states keep the content inset. */
  mainFill?: boolean | undefined;
  /** While a draft is open no sidebar row is current. */
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
  /** `prefix space`: the palette; also usable while Settings pauses the rest of the keymap. */
  paletteShortcut?: VisualShortcut | undefined;
  /** True while Settings is open: only the palette's two-key sequence stays live. */
  paletteKeysEnabled?: boolean | undefined;
  /** What the working area's own dispatch says about the actions it owns. */
  taskActionAvailability?: Readonly<Partial<Record<ActionId, ActionAvailability>>> | undefined;
  /** A bound chord whose action is unavailable; the reason is guidance, not a failed action. */
  onActionRefused?: ((reason: string) => void) | undefined;
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
   * The live connection banner and its recovery surfaces, and the footer that carries `notice`:
   * a host without a status has no footer band, so a notice passed to it goes unmounted.
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

/**
 * The scroller's edge fades: each appears only while rows stay hidden on that side, so a short
 * list never looks clipped and a full one still says it can scroll without a scrollbar lane.
 */
function useScrollFade(node: HTMLDivElement | null) {
  const update = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    if (node === null) return undefined;
    const sync = () => {
      node.toggleAttribute("data-fade-top", node.scrollTop > 1);
      node.toggleAttribute(
        "data-fade-bottom",
        node.scrollTop + node.clientHeight < node.scrollHeight - 1,
      );
    };
    update.current = sync;
    node.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [node]);
  // Mounting a page or collapsing the shelf changes the content, not the scroller's own box.
  useLayoutEffect(() => {
    update.current();
  });
}

function SidebarList({
  rows,
  projectsLoaded,
  hasProjects = false,
  tasksLoaded,
  failure,
  renderRow,
  shelves,
}: Pick<
  VisualShellViewProps,
  "rows" | "projectsLoaded" | "hasProjects" | "tasksLoaded" | "failure"
> & {
  renderRow: (row: VisualTaskRow) => ReactNode;
  /** The shelves: the same scroller, so the sidebar stays one scrolling region. */
  shelves?: ReactNode | undefined;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useScrollFade(scroller);
  if (failure !== undefined) {
    return (
      <div className="visual-task-scroll" ref={setScroller}>
        <div className="visual-list-state" role="alert">
          <WorkspaceState hasProjects={hasProjects} failure={failure} />
        </div>
      </div>
    );
  }
  if (!projectsLoaded || !tasksLoaded) {
    return (
      <div className="visual-task-scroll" ref={setScroller}>
        <div className="visual-list-state" aria-live="polite">
          <span className="visual-list-state-title">Loading tasks…</span>
        </div>
      </div>
    );
  }
  return (
    <div className="visual-task-scroll" ref={setScroller}>
      {rows.length === 0 ? (
        <div className="visual-list-state">
          <WorkspaceState hasProjects={hasProjects} failure={undefined} />
        </div>
      ) : (
        <ul className="visual-task-list" aria-label="Tasks">
          {rows.map(renderRow)}
        </ul>
      )}
      {shelves}
    </div>
  );
}

/** The settled list's one id, so the disclosure's expanded state names the list it opens. */
const SETTLED_LIST_ID = "visual-settled-list";
/** The Snoozed shelf's id, one per list so `aria-controls` cannot name the other shelf. */
const SNOOZED_LIST_ID = "visual-snoozed-list";

/**
 * One shelf below the active list: the snoozed tasks or the settled ones. Collapsed, it keeps the
 * current task's row alone, so closing a shelf never hides what the main area shows.
 */
function TaskShelf({
  label,
  listId,
  listLabel,
  shown,
  hiddenCount,
  expanded,
  onToggle,
  onStep,
  onMoreStep,
  onShowMore,
  toggleRef,
  moreRef,
  renderRow,
}: {
  label: string;
  listId: string;
  listLabel: string;
  /** The rows mounted now: one page expanded, the current one alone collapsed. */
  shown: readonly VisualTaskRow[];
  /** Rows beyond the mounted page; positive ends the shelf with a Show more row. */
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
  /** An arrow from the disclosure: the next stop in the sidebar's order. */
  onStep: (direction: -1 | 1) => void;
  /** An arrow from Show more: the same walk, from that row's place in it. */
  onMoreStep: (direction: -1 | 1) => void;
  onShowMore: () => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  moreRef: RefObject<HTMLButtonElement | null>;
  renderRow: (row: VisualTaskRow) => ReactNode;
}) {
  return (
    <div className="visual-shelf">
      <VisualShelfToggle
        label={label}
        expanded={expanded}
        ariaControls={listId}
        onToggle={onToggle}
        onStep={onStep}
        buttonRef={toggleRef}
      />
      {/* Always mounted, so the disclosure's `aria-controls` names a real list in every state. */}
      <ul id={listId} className="visual-task-list" aria-label={listLabel}>
        {shown.map(renderRow)}
      </ul>
      {hiddenCount > 0 && (
        <VisualShelfMore
          label={`Show ${Math.min(hiddenCount, SHELF_PAGE_COUNT)} more`}
          onClick={onShowMore}
          onStep={onMoreStep}
          buttonRef={moreRef}
        />
      )}
    </div>
  );
}

/**
 * One shelf's paging: the open shelf mounts one page and grows only on request, while a collapsed
 * shelf mounts the current row alone. Both shelves share this rule, so a hidden row behaves alike.
 */
function useShelfPage(
  rows: readonly VisualTaskRow[],
  expanded: boolean,
  currentId: string | undefined,
) {
  const [visibleCount, setVisibleCount] = useState(SHELF_INITIAL_COUNT);
  const page = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);
  const current = rows.find((row) => row.id === currentId);
  const shown = useMemo(() => {
    if (!expanded) return current === undefined ? [] : [current];
    // A route can name a row below the mounted page: mount it on its own, as the closed shelf
    // mounts its current row, rather than mounting every older row above it.
    if (current === undefined || page.includes(current)) return page;
    return [...page, current];
  }, [current, expanded, page]);
  const hiddenCount = Math.max(0, rows.length - visibleCount);
  const reveal = useCallback(() => {
    const next = rows[visibleCount]?.id;
    setVisibleCount((count) => count + SHELF_PAGE_COUNT);
    return next;
  }, [rows, visibleCount]);
  return { shown, hiddenCount, showMore: expanded && hiddenCount > 0, reveal };
}

export function TaskMain({ row }: { row: VisualTaskRow }) {
  return (
    <div className="visual-main-task">
      <span className="visual-project-avatar" aria-hidden="true">
        {row.projectInitial}
      </span>
      <span className="visual-main-project">{row.project}</span>
      <span className="visual-main-divider" aria-hidden="true">
        /
      </span>
      <h1 className="visual-main-title">{row.title}</h1>
    </div>
  );
}

function WorkspaceState({
  hasProjects,
  failure,
  main = false,
}: {
  hasProjects: boolean;
  failure: string | undefined;
  main?: boolean;
}) {
  return (
    <>
      <span className={main ? "visual-main-empty-title" : "visual-list-state-title"}>
        {failure !== undefined ? "The workspace could not load." : "No active tasks."}
      </span>
      <span className={main ? undefined : "visual-list-state-detail"}>
        {failure ??
          (hasProjects
            ? "Start one with New task."
            : "Add a project, or start without one with New task.")}
      </span>
    </>
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
      {failure !== undefined || rows.length === 0 ? (
        <WorkspaceState hasProjects={hasProjects} failure={failure} main />
      ) : (
        <>
          <span className="visual-main-empty-title">No task selected.</span>
          <span>Choose a task in the sidebar.</span>
        </>
      )}
    </div>
  );
}

/**
 * The whole shell's presentation. Production passes live store rows; the review host passes
 * fixtures through this same component, never through a copy of it.
 */
export function VisualShellView({
  rows,
  settledRows: settled = NO_ROWS,
  snoozedRows = NO_ROWS,
  snoozePresets = NO_SNOOZE_PRESETS,
  snoozeNow = 0,
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
  paletteShortcut,
  paletteKeysEnabled = false,
  taskActionAvailability,
  onActionRefused,
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
  const snoozedShelf = useSnoozedShelf();
  const dialogFocus = useDialogFocus();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The selection may name a snoozed or settled task: both shelves are part of the one list, so a
  // hidden row is found before the fallback to the first active one.
  const selected =
    selectedId === null
      ? undefined
      : ([...rows, ...snoozedRows, ...settled].find((row) => row.id === selectedId) ?? rows[0]);
  // A copy answers where the window ends, not in the sidebar: the menu that asked is gone by the
  // time the clipboard settles, so the toast is the only record of what was taken. Each copy gets
  // its own card, so copying a path, then a branch, leaves both readable in the stack. A refusal
  // is high priority, which is what makes the region announce it urgently.
  const copy = useCallback((text: string, copied: string) => {
    void copyText(text, copied).then((outcome) => {
      const failed = outcome.outcome === "refused";
      toast.add({
        title: outcome.message,
        type: failed ? "error" : "success",
        priority: failed ? "high" : "low",
        timeout: COPY_TOAST_MS,
      });
    });
  }, []);
  const selectTask = useCallback(
    (id: string | null) => {
      onSelectTask(id);
    },
    [onSelectTask],
  );
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const newTaskButton = useRef<HTMLButtonElement>(null);
  const sidebarFrame = useRef<HTMLElement>(null);
  const shelfToggle = useRef<HTMLButtonElement>(null);
  const settledMore = useRef<HTMLButtonElement>(null);
  const snoozedShelfToggle = useRef<HTMLButtonElement>(null);
  const snoozedMore = useRef<HTMLButtonElement>(null);
  // The row a page reveals, so the keyboard lands in the list when Show more unmounts instead.
  const pendingSettledRow = useRef<string | undefined>(undefined);
  const pendingSnoozedRow = useRef<string | undefined>(undefined);
  const toggleLayer = useRef<HTMLDivElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const openToggleSlot = useRef<HTMLSpanElement>(null);
  const closedToggleSlot = useRef<HTMLSpanElement>(null);
  const pendingFocus = useRef<number | null>(null);
  /** Where a moved row came from, until the row lands in its new list or the user moves on. */
  const moveFocus = useRef<{ id: string; from: RowHome } | undefined>(undefined);
  /**
   * The row on screen when it was snoozed, until the watch removes it. A selection it would make
   * must not overwrite a choice the user made while the write was in flight.
   */
  const parkFocus = useRef<{ id: string; index: number } | undefined>(undefined);
  // One transient-state clear for both: a moved row's focus intent and a parked selection end
  // on the user's next input, so neither can act after the user has moved on.
  const clearTransient = useCallback(() => {
    moveFocus.current = undefined;
    parkFocus.current = undefined;
  }, []);
  const prefix =
    shortcut?.prefix ??
    newTaskShortcut?.prefix ??
    findTaskShortcut?.prefix ??
    settingsShortcut?.prefix ??
    renameShortcut?.prefix ??
    removeShortcut?.prefix ??
    paletteShortcut?.prefix ??
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
    if (paletteShortcut?.binding !== null && paletteShortcut?.binding !== undefined)
      bindings[paletteShortcut.binding] = "command-palette";
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
    paletteShortcut,
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
  const taskOrder = useMemo(
    () => [...rows, ...snoozedRows, ...settled].map((row) => row.id),
    [rows, snoozedRows, settled],
  );
  // What each shelf mounts: one page while open, the current row alone while closed.
  const {
    shown: shownSnoozed,
    hiddenCount: hiddenSnoozed,
    showMore: moreSnoozed,
    reveal: revealSnoozed,
  } = useShelfPage(snoozedRows, snoozedShelf.expanded, currentTaskId);
  const {
    shown: shownSettled,
    hiddenCount: hiddenSettled,
    showMore: moreSettled,
    reveal: revealSettled,
  } = useShelfPage(settled, shelf.expanded, currentTaskId);
  // Navigation and a moved row's intent read the rows as they are *now*, through refs, so their
  // callbacks stay one identity across a status tick instead of re-rendering every mounted card.
  const rowsRef = useRef(rows);
  const snoozedRef = useRef(snoozedRows);
  const settledRef = useRef(settled);
  const shownSnoozedRef = useRef(shownSnoozed);
  const shownSettledRef = useRef(shownSettled);
  const moreSnoozedVisibleRef = useRef(moreSnoozed);
  const moreSettledVisibleRef = useRef(moreSettled);
  useLayoutEffect(() => {
    rowsRef.current = rows;
    snoozedRef.current = snoozedRows;
    settledRef.current = settled;
    shownSnoozedRef.current = shownSnoozed;
    shownSettledRef.current = shownSettled;
    moreSnoozedVisibleRef.current = moreSnoozed;
    moreSettledVisibleRef.current = moreSettled;
  }, [rows, snoozedRows, settled, shownSnoozed, shownSettled, moreSnoozed, moreSettled]);
  // Every keyboard stop in the sidebar's order: the active cards, then each shelf's toggle, the
  // rows it mounts and its Show more.
  const navigate = useCallback(
    (from: string, direction: -1 | 1) => {
      const stops = rowsRef.current.map((row) => row.id);
      if (snoozedRef.current.length > 0) {
        stops.push(SNOOZE_SHELF_STOP);
        for (const row of shownSnoozedRef.current) stops.push(row.id);
        if (moreSnoozedVisibleRef.current) stops.push(SNOOZE_SHELF_MORE_STOP);
      }
      if (settledRef.current.length > 0) {
        stops.push(SETTLED_SHELF_STOP);
        for (const row of shownSettledRef.current) stops.push(row.id);
        if (moreSettledVisibleRef.current) stops.push(SETTLED_SHELF_MORE_STOP);
      }
      const index = stops.indexOf(from);
      if (index === -1) return;
      const next = stops[Math.min(stops.length - 1, Math.max(0, index + direction))];
      if (next === undefined || next === from) return;
      switch (next) {
        case SNOOZE_SHELF_STOP:
          snoozedShelfToggle.current?.focus();
          return;
        case SNOOZE_SHELF_MORE_STOP:
          snoozedMore.current?.focus();
          return;
        case SETTLED_SHELF_STOP:
          shelfToggle.current?.focus();
          return;
        case SETTLED_SHELF_MORE_STOP:
          settledMore.current?.focus();
          return;
        default:
          selectRow(next);
      }
    },
    [selectRow],
  );
  const showMoreSnoozed = useCallback(() => {
    pendingSnoozedRow.current = revealSnoozed();
  }, [revealSnoozed]);
  const showMoreSettled = useCallback(() => {
    pendingSettledRow.current = revealSettled();
  }, [revealSettled]);
  // Show more stays mounted while rows remain, so it keeps the keyboard; the appended page is
  // scrolled into view. Only the last page unmounts it, and then the keyboard lands on that row.
  useLayoutEffect(() => {
    const pending = pendingSnoozedRow.current;
    if (pending === undefined) return;
    // The new page is mounted by this render; an id that is gone means the list moved on.
    if (!shownSnoozed.some((row) => row.id === pending)) {
      pendingSnoozedRow.current = undefined;
      return;
    }
    pendingSnoozedRow.current = undefined;
    if (moreSnoozed) {
      rowElement(pending)?.scrollIntoView({ block: "nearest" });
      return;
    }
    rowElement(pending)?.focus();
  }, [moreSnoozed, rowElement, shownSnoozed]);
  useLayoutEffect(() => {
    const pending = pendingSettledRow.current;
    if (pending === undefined) return;
    if (!shownSettled.some((row) => row.id === pending)) {
      pendingSettledRow.current = undefined;
      return;
    }
    pendingSettledRow.current = undefined;
    if (moreSettled) {
      rowElement(pending)?.scrollIntoView({ block: "nearest" });
      return;
    }
    rowElement(pending)?.focus();
  }, [moreSettled, rowElement, shownSettled]);
  const settle = taskActions?.onToggleSettle;
  // Reads the props, not the refs: a changed list is a changed identity, which is what re-runs the
  // effect that hands the keyboard to the row's new home.
  const homeOf = useCallback(
    (id: string): RowHome | undefined => {
      if (rows.some((row) => row.id === id)) return "active";
      if (snoozedRows.some((row) => row.id === id)) return "snoozed";
      if (settled.some((row) => row.id === id)) return "settled";
      return undefined;
    },
    [rows, snoozedRows, settled],
  );
  // Every row-originated action that moves the row between lists remounts it, so its new home
  // takes the keyboard back. A menu item lives in a portal, so this path cannot ask whether the
  // sidebar held focus; the prefix actions ask that in their own callback.
  const moveRow = useCallback(
    (id: string, run: () => Promise<boolean>) => {
      const from = homeOf(id);
      if (from === undefined) return;
      moveFocus.current = { id, from };
      void run().then(
        (accepted) => {
          // False means the server refused it or nothing moved; either way there is nothing to
          // hand the keyboard back to.
          if (!accepted && moveFocus.current?.id === id) moveFocus.current = undefined;
        },
        () => {
          if (moveFocus.current?.id === id) moveFocus.current = undefined;
        },
      );
    },
    [homeOf],
  );
  const settleRow = useCallback(
    (id: string) => {
      if (settle === undefined) return;
      moveRow(id, () => settle(id));
    },
    [moveRow, settle],
  );
  const snooze = taskActions?.onSnooze;
  /**
   * Snoozing the row on screen leaves nothing to look at, so the row that took its place is
   * selected once the watch lands, or `No task selected.` when it was the last one.
   */
  const snoozeRow = useCallback(
    async (id: string, snoozedUntil: number): Promise<SnoozeOutcome> => {
      if (snooze === undefined) return { accepted: false };
      if (id !== currentTaskId) {
        const from = homeOf(id);
        if (from === undefined) return { accepted: false };
        moveFocus.current = { id, from };
        const outcome = await snooze(id, snoozedUntil);
        if (!outcome.accepted && moveFocus.current?.id === id) moveFocus.current = undefined;
        return outcome;
      }
      parkFocus.current = {
        id,
        index: rowsRef.current.findIndex((row) => row.id === id),
      };
      const outcome = await snooze(id, snoozedUntil);
      if (!outcome.accepted && parkFocus.current?.id === id) parkFocus.current = undefined;
      return outcome;
    },
    [currentTaskId, homeOf, snooze],
  );
  const unsnooze = taskActions?.onUnsnooze;
  const wakeRow = useCallback(
    (id: string) => {
      if (unsnooze === undefined) return;
      moveRow(id, () => unsnooze(id));
    },
    [moveRow, unsnooze],
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
    const parked = parkFocus.current;
    if (parked === undefined) return;
    // Wait for the watch: while the row is still active there is nothing to hand the keyboard to.
    if (rows.some((row) => row.id === parked.id)) return;
    parkFocus.current = undefined;
    const next = rows[parked.index] ?? rows[0];
    selectTask(next?.id ?? null);
    if (next === undefined) {
      newTaskButton.current?.focus();
      return;
    }
    requestAnimationFrame(() => rowElement(next.id)?.focus());
  }, [rows, rowElement, selectTask]);
  useLayoutEffect(() => {
    const pending = moveFocus.current;
    if (pending === undefined) return;
    const home = homeOf(pending.id);
    if (home === undefined || home === pending.from) return;
    moveFocus.current = undefined;
    const row = rowElement(pending.id);
    // The row went into a collapsed shelf and is not mounted: its disclosure now names it.
    if (row !== null) row.focus();
    else if (home === "snoozed") snoozedShelfToggle.current?.focus();
    else if (home === "settled") shelfToggle.current?.focus();
  }, [homeOf, rowElement]);
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
  useImperativeHandle(rowFocus, () => ({ rowElement, fallbackElement, snooze: snoozeRow }), [
    fallbackElement,
    rowElement,
    snoozeRow,
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
  const openPalette = useCallback(() => {
    // The palette's own close must return to what had the keyboard when it opened, not to a
    // target an earlier overlay left in the shared provider.
    dialogFocus?.remember();
    setPaletteOpen(true);
  }, [dialogFocus]);
  /** The one dispatch: chords, palette rows and mirrored controls all reach their action here. */
  const dispatch = useCallback(
    (action: string) => {
      if (action === "toggle-sidebar") toggleSidebar();
      else if (action === "new-task") onNewTask?.();
      else if (action === "find-task") onFindTask?.();
      else if (action === "settings") onOpenSettings?.();
      else if (action === "add-project") onAddProject?.();
      else if (action === "focus-sidebar") focusList();
      else if (action === "command-palette") openPalette();
      else if (action === "next-task" || action === "previous-task") {
        const next = stepActive(taskOrder, selected?.id, action === "next-task" ? 1 : -1);
        if (next !== undefined) selectTask(next);
      } else if (action === "rename-task" || action === "remove-task" || action === "settle-task") {
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
      openPalette,
      prefixExtra,
      selected?.id,
      selectTask,
      taskActions,
      taskOrder,
      toggleSidebar,
      toggleSettle,
    ],
  );
  const actions = useMemo<ActionTable>(() => {
    const availabilityFor = (action: ActionId): ActionAvailability => {
      // A session action needs a task on screen; the working area says the same for every one.
      if (ACTION_GROUP_OF[action] === "Sessions" && currentTaskId === undefined)
        return actionAvailability(false, "Select a task first.");
      switch (action) {
        case "toggle-sidebar":
        case "focus-sidebar":
        case "command-palette":
        case "find-task":
          return { enabled: true };
        case "new-task":
          return actionAvailability(onNewTask !== undefined, "Creating tasks is unavailable here.");
        case "settings":
          return actionAvailability(onOpenSettings !== undefined, "Settings is unavailable here.");
        case "add-project":
          return actionAvailability(
            onAddProject !== undefined,
            "Adding projects is unavailable here.",
          );
        case "rename-task":
          return actionAvailability(currentTaskId !== undefined, "Select a task to rename.");
        case "remove-task":
          return actionAvailability(currentTaskId !== undefined, "Select a task to remove.");
        case "settle-task":
          return actionAvailability(currentTaskId !== undefined, "Select a task to settle.");
        case "next-task": {
          const next = stepActive(taskOrder, selected?.id, 1);
          return actionAvailability(
            next !== undefined && next !== selected?.id,
            "There is no next task.",
          );
        }
        case "previous-task": {
          const previous = stepActive(taskOrder, selected?.id, -1);
          return actionAvailability(
            previous !== undefined && previous !== selected?.id,
            "There is no previous task.",
          );
        }
        default:
          return taskActionAvailability?.[action] ?? { enabled: true };
      }
    };
    const entryFor = (action: ActionId): ActionEntry => {
      const availability = availabilityFor(action);
      return availability.enabled
        ? {
            label: ACTION_LABELS[action],
            group: ACTION_GROUP_OF[action],
            enabled: true,
            run: () => dispatch(action),
          }
        : {
            label: ACTION_LABELS[action],
            group: ACTION_GROUP_OF[action],
            enabled: false,
            reason: availability.reason,
            run: () => dispatch(action),
          };
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one entry per ActionId option
    const table = Object.fromEntries(
      ActionId.options.map((action): [ActionId, ActionEntry] => [action, entryFor(action)]),
    ) as ActionTable;
    return table;
  }, [
    currentTaskId,
    dispatch,
    onAddProject,
    onNewTask,
    onOpenSettings,
    selected?.id,
    taskActionAvailability,
    taskOrder,
  ]);
  /** A chord on an unavailable action says why instead of running it. */
  const runAction = useCallback(
    (action: string) => {
      const parsed = ActionId.safeParse(action);
      const entry = parsed.success ? actions[parsed.data] : undefined;
      if (entry === undefined) {
        dispatch(action);
        return;
      }
      if (!entry.enabled) {
        onActionRefused?.(entry.reason);
        return;
      }
      entry.run();
    },
    [actions, dispatch, onActionRefused],
  );
  const armed = usePrefixMode(
    keymap,
    runAction,
    prefixEnabled && !paletteOpen,
    directKeymap === undefined || direct === undefined
      ? undefined
      : { keymap: directKeymap, onAction: direct.onAction },
  );
  usePausedPalette(
    paletteShortcut?.prefix ?? prefix,
    paletteShortcut?.binding ?? null,
    openPalette,
    paletteKeysEnabled && !paletteOpen,
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
          onAcknowledgeWoke={
            taskActions?.onAcknowledgeWoke === undefined
              ? undefined
              : () => taskActions.onAcknowledgeWoke?.(row.id)
          }
          menu={
            taskActions === undefined ? undefined : (
              <TaskRowMenu
                row={row}
                actions={taskActions}
                onToggleSettle={settle === undefined ? undefined : settleRow}
                onSnooze={
                  snooze === undefined ? undefined : (id, until) => void snoozeRow(id, until)
                }
                onUnsnooze={unsnooze === undefined ? undefined : wakeRow}
                onSnoozeCustom={taskActions.onSnoozeCustom}
                snoozePresets={snoozePresets}
                now={snoozeNow}
                renameShortcut={renameShortcut}
                removeShortcut={removeShortcut}
                settleShortcut={settleShortcut}
                onCopy={copy}
              />
            )
          }
        />
      </li>
    ),
    [
      copy,
      currentTaskId,
      navigate,
      removeShortcut,
      renameShortcut,
      selectRow,
      settle,
      settleRow,
      settleShortcut,
      snooze,
      snoozeNow,
      snoozePresets,
      snoozeRow,
      taskActions,
      unsnooze,
      wakeRow,
    ],
  );
  const shelves =
    snoozedRows.length + settled.length === 0 ? undefined : (
      <div className="visual-shelves">
        {snoozedRows.length > 0 && (
          <TaskShelf
            label={`Snoozed (${snoozedRows.length})`}
            listId={SNOOZED_LIST_ID}
            listLabel="Snoozed tasks"
            shown={shownSnoozed}
            hiddenCount={moreSnoozed ? hiddenSnoozed : 0}
            expanded={snoozedShelf.expanded}
            onToggle={snoozedShelf.toggle}
            onStep={(direction) => navigate(SNOOZE_SHELF_STOP, direction)}
            onMoreStep={(direction) => navigate(SNOOZE_SHELF_MORE_STOP, direction)}
            onShowMore={showMoreSnoozed}
            toggleRef={snoozedShelfToggle}
            moreRef={snoozedMore}
            renderRow={renderRow}
          />
        )}
        {settled.length > 0 && (
          <TaskShelf
            label={`Settled (${settled.length})`}
            listId={SETTLED_LIST_ID}
            listLabel="Settled tasks"
            shown={shownSettled}
            hiddenCount={moreSettled ? hiddenSettled : 0}
            expanded={shelf.expanded}
            onToggle={shelf.toggle}
            onStep={(direction) => navigate(SETTLED_SHELF_STOP, direction)}
            onMoreStep={(direction) => navigate(SETTLED_SHELF_MORE_STOP, direction)}
            onShowMore={showMoreSettled}
            toggleRef={shelfToggle}
            moreRef={settledMore}
            renderRow={renderRow}
          />
        )}
      </div>
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
            shelves={shelves}
          />
        </TooltipProvider>
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
            failure={notice}
            onDismissFailure={() => {
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
            failure={notice}
            onDismissFailure={() => {
              onDismissNotice?.();
            }}
            onOpenConfigProblems={status.onOpenConfigProblems}
          />
        )}
        <div className="visual-task-surface">
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
        </div>
      </main>
      {paletteOpen && (
        <CommandPaletteDialog
          actions={actions}
          onClose={(action) => {
            setPaletteOpen(false);
            if (action !== undefined) runAction(action);
          }}
        />
      )}
    </div>
  );
}
