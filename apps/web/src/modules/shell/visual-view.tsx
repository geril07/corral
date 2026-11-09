import { createPrefixKeymap } from "@corral/client/prefix-keymap";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  VisualIconButton,
  VisualResizeHandle,
  VisualSearchAction,
  VisualSidebar,
  VisualTaskCard,
  VisualTooltipProvider,
  type VisualShortcut,
  type VisualTaskRow,
} from "../../common/ui/index.ts";
import { usePrefixMode } from "../keymap/index.ts";
import {
  useVisualSidebarPane,
  VISUAL_SIDEBAR_MAX_WIDTH,
  VISUAL_SIDEBAR_MIN_WIDTH,
} from "./sidebar-pane.ts";

export interface VisualShellViewProps {
  rows: readonly VisualTaskRow[];
  /** `null` means the user explicitly chose no task; `undefined` falls back to the first row. */
  selectedId: string | null | undefined;
  projectsLoaded: boolean;
  tasksLoaded: boolean;
  failure: string | undefined;
  shortcut: VisualShortcut | undefined;
  onSelectTask: (id: string) => void;
  /** A real, safe path when the shell has one; absent in the review host. */
  onAddProject?: (() => void) | undefined;
  /** False while a dialog owns the keyboard, so the prefix cannot swallow its typing. */
  prefixEnabled?: boolean | undefined;
}

function SidebarList({
  rows,
  selectedId,
  projectsLoaded,
  tasksLoaded,
  failure,
  onSelectTask,
}: Pick<
  VisualShellViewProps,
  "rows" | "selectedId" | "projectsLoaded" | "tasksLoaded" | "failure" | "onSelectTask"
>) {
  const list = useRef<HTMLDivElement>(null);
  const selected =
    selectedId === null ? undefined : (rows.find((row) => row.id === selectedId) ?? rows[0]);

  const focusRow = useCallback((id: string) => {
    requestAnimationFrame(() => {
      list.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`)?.focus();
    });
  }, []);

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
  if (rows.length === 0) {
    return (
      <div className="visual-task-scroll">
        <div className="visual-list-state">
          <span className="visual-list-state-title">No active tasks.</span>
          <span className="visual-list-state-detail">Add a project to start one.</span>
        </div>
      </div>
    );
  }
  return (
    <div className="visual-task-scroll" ref={list}>
      <ul className="visual-task-list" aria-label="Tasks">
        {rows.map((row) => (
          <li key={row.id}>
            <VisualTaskCard
              row={row}
              selected={selected?.id === row.id}
              onSelect={select}
              onNavigate={navigate}
              settleReason="Settle is not part of this visual slice and is not connected to the old stop-all action."
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
        {row.project} · {row.metadata.branch}
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
  failure,
}: {
  rows: readonly VisualTaskRow[];
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
            ? "Add a project from the sidebar footer to get started."
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
  tasksLoaded,
  failure,
  shortcut,
  onSelectTask,
  onAddProject,
  prefixEnabled = true,
}: VisualShellViewProps) {
  const pane = useVisualSidebarPane();
  const selected =
    selectedId === null ? undefined : (rows.find((row) => row.id === selectedId) ?? rows[0]);
  const selectedRowId = selected?.id;
  const showToggle = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const keymap = useMemo(
    () =>
      createPrefixKeymap(
        shortcut?.prefix ?? "alt+a",
        shortcut?.binding === null || shortcut?.binding === undefined
          ? {}
          : { [shortcut.binding]: "toggle-sidebar" },
      ),
    [shortcut],
  );
  const { hidden, toggle } = pane;
  const toggleSidebar = useCallback(() => {
    const willHide = !hidden;
    toggle();
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
    pendingFocus.current = requestAnimationFrame(() => {
      pendingFocus.current = null;
      if (willHide) {
        showToggle.current?.focus();
        return;
      }
      const id = selectedRowId;
      if (id === undefined) return;
      document
        .querySelector<HTMLElement>(`.visual-task-card-hit[data-task-id="${CSS.escape(id)}"]`)
        ?.focus();
    });
  }, [hidden, selectedRowId, toggle]);
  const runAction = useCallback(
    (action: string) => {
      if (action === "toggle-sidebar") toggleSidebar();
    },
    [toggleSidebar],
  );
  usePrefixMode(keymap, runAction, prefixEnabled);

  useEffect(
    () => () => {
      if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
    },
    [],
  );

  return (
    <VisualTooltipProvider>
      <div className="visual-shell-screen">
        <VisualSidebar
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
            <VisualIconButton
              label="Hide sidebar"
              icon="hide-sidebar"
              onClick={toggleSidebar}
              shortcut={shortcut}
              ariaExpanded
              ariaControls="visual-sidebar"
            />
          </div>
          <div className="visual-sidebar-actions">
            <VisualSearchAction
              label="Search tasks…"
              disabledReason="Task search is not part of this visual slice."
            />
            <VisualIconButton
              label="New task"
              icon="add"
              disabledReason="Creating tasks is not part of this visual slice."
            />
          </div>
          <SidebarList
            rows={rows}
            selectedId={selected?.id}
            projectsLoaded={projectsLoaded}
            tasksLoaded={tasksLoaded}
            failure={failure}
            onSelectTask={onSelectTask}
          />
          <div className="visual-sidebar-footer">
            <VisualIconButton
              label="Settings"
              icon="settings"
              disabledReason="Settings is not part of this visual slice."
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
            {pane.hidden && (
              <VisualIconButton
                label="Show sidebar"
                icon="show-sidebar"
                onClick={toggleSidebar}
                shortcut={shortcut}
                buttonRef={showToggle}
                ariaExpanded={false}
                ariaControls="visual-sidebar"
              />
            )}
          </div>
          <div className="visual-main-content">
            {selected === undefined ? (
              <EmptyMain rows={rows} failure={failure} />
            ) : (
              <TaskMain row={selected} />
            )}
          </div>
        </main>
      </div>
    </VisualTooltipProvider>
  );
}
