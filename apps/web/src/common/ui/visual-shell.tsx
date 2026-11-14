import { ContextMenu } from "@base-ui/react/context-menu";
import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { Icon, type IconName } from "./icon.tsx";
import { RowMenuPopup } from "./row-menu.tsx";
import {
  Tooltip,
  TooltipCompact,
  TooltipContent,
  TooltipExplanation,
  TooltipMetadata,
  TooltipTrigger,
  type TooltipMetadataFact,
  type TooltipShortcut,
} from "./tooltip.tsx";

/** The compact tooltip's shortcut, split into the prefix chord and the action chord. */
export type VisualShortcut = TooltipShortcut;

/** A task's genuinely known runtime identity; unknown parts stay absent rather than invented. */
export interface VisualTaskAgent {
  kind: string;
  model?: string | undefined;
  provider?: string | undefined;
}

/** The status slot of a task card, already resolved from the primary session. */
export interface VisualCardStatus {
  tone: "working" | "blocked" | "error" | "done" | "neutral";
  /** Absent for seen Done; Idle keeps its label with a neutral tone. */
  label?: string | undefined;
  /** Absent when no trustworthy timestamp exists (Working has no reliable start). */
  time?: string | undefined;
  muted?: boolean | undefined;
  /** The agent's own sentence, shown in the metadata tooltip rather than the card. */
  message?: string | undefined;
}

/** Facts the metadata tooltip may show; every one came from the server. */
export interface VisualTaskMetadata {
  project: string;
  branch?: string | undefined;
  agent?: VisualTaskAgent | undefined;
  prompt?: string | undefined;
}

export interface VisualTaskRow {
  id: string;
  title: string;
  project: string;
  projectInitial: string;
  /** The absolute workspace path a task's terminals start in; the menu copies it verbatim. */
  workspacePath: string;
  /** Whether the task was created from an issue URL; the source item exists only then. */
  hasSource: boolean;
  /** The recorded branch when it is a real branch name to copy; a detached create has none. */
  copyBranch?: string | undefined;
  /** The server-owned task state: a settled row names `Unsettle task` in its menu and action. */
  settled?: boolean | undefined;
  status?: VisualCardStatus | undefined;
  metadata: VisualTaskMetadata;
}

/** One canonical tooltip: a label-only hint, or an explanation stacked under its action title. */
function CompactTooltip({
  label,
  reason,
  shortcut,
  children,
}: {
  label: string;
  reason?: string | undefined;
  shortcut?: VisualShortcut | undefined;
  children: ReactElement;
}) {
  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger render={children} />
      <TooltipContent
        variant={reason === undefined ? "compact" : "explanation"}
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
      >
        {reason === undefined ? (
          <TooltipCompact label={label} shortcut={shortcut} />
        ) : (
          <TooltipExplanation label={label} reason={reason} shortcut={shortcut} />
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export interface VisualIconButtonProps {
  label: string;
  icon: IconName;
  onClick?: (() => void) | undefined;
  /**
   * When set, the control stays focusable and announces `aria-disabled`, and the tooltip says why.
   * It performs no action: an unavailable feature is never a silent no-op.
   */
  disabledReason?: string | undefined;
  shortcut?: VisualShortcut | undefined;
  ariaExpanded?: boolean | undefined;
  ariaControls?: string | undefined;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

/** A 28×28 ghost icon action. */
export function VisualIconButton({
  label,
  icon,
  onClick,
  disabledReason,
  shortcut,
  ariaExpanded,
  ariaControls,
  buttonRef,
}: VisualIconButtonProps) {
  const disabled = disabledReason !== undefined;
  return (
    <CompactTooltip label={label} reason={disabledReason} shortcut={shortcut}>
      <button
        ref={buttonRef}
        type="button"
        className="visual-icon-button"
        aria-label={label}
        aria-disabled={disabled ? "true" : undefined}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        onClick={disabled ? undefined : onClick}
      >
        <Icon name={icon} />
      </button>
    </CompactTooltip>
  );
}

/** The wide ghost Search action row: 28 high, inline padding 8, gap 8, radius 6. */
export function VisualSearchAction({
  label,
  shortcut,
  onClick,
}: {
  label: string;
  shortcut?: VisualShortcut | undefined;
  onClick: () => void;
}) {
  return (
    <CompactTooltip label={label} shortcut={shortcut}>
      <button type="button" className="visual-sidebar-row" onClick={onClick}>
        <Icon name="find" />
        <span className="visual-sidebar-label">{label}</span>
      </button>
    </CompactTooltip>
  );
}

/** The sidebar's one disclosure row: the wide ghost row with a chevron and a label. */
export function VisualShelfToggle({
  label,
  expanded,
  ariaControls,
  onToggle,
  onStep,
  buttonRef,
}: {
  label: string;
  expanded: boolean;
  /** The list this row discloses, so the expanded state names its target. */
  ariaControls?: string | undefined;
  onToggle: () => void;
  /** An arrow from the row: the next keyboard stop in the list's order. */
  onStep: (direction: -1 | 1) => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="visual-sidebar-row"
      data-tone="muted"
      aria-expanded={expanded}
      aria-controls={ariaControls}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        onStep(event.key === "ArrowDown" ? 1 : -1);
      }}
    >
      <Icon name={expanded ? "collapse" : "expand"} />
      <span className="visual-sidebar-label">{label}</span>
    </button>
  );
}

/** The sidebar's drag edge: pointer drag and arrow keys, bounded by the caller. */
export function VisualResizeHandle({
  width,
  min,
  max,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onResizeStart?: (() => void) | undefined;
  onResizeEnd?: (() => void) | undefined;
}) {
  const keyStep = 16;
  const [dragging, setDragging] = useState(false);
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(true);
    onResizeStart?.();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    const move = (moved: PointerEvent) => onResize(startWidth + (moved.clientX - startX));
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      handle.removeEventListener("lostpointercapture", stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      setDragging(false);
      onResizeEnd?.();
    };
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("lostpointercapture", stop);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="visual-resize-handle"
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={drag}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onResize(width - keyStep);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onResize(width + keyStep);
        }
      }}
    />
  );
}

/** The sidebar frame: its width is a device preference, its insets are the shell's. */
export function VisualSidebar({
  width,
  hidden,
  resizing,
  resize,
  frameRef,
  children,
}: {
  width: number;
  hidden: boolean;
  resizing: boolean;
  /** The drag edge sits outside the clipped surface, at the frame's real edge. */
  resize?: ReactNode | undefined;
  frameRef?: Ref<HTMLElement> | undefined;
  children: ReactNode;
}) {
  return (
    <aside
      ref={frameRef}
      id="visual-sidebar"
      className="visual-shell-sidebar"
      data-hidden={hidden ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
      aria-hidden={hidden ? "true" : undefined}
      style={{ width: hidden ? 0 : width }}
    >
      {/* This layer clips the fixed-width contents; the frame itself stays open so the grip can
          straddle the sidebar/main boundary instead of losing half its hit area. */}
      <div className="visual-sidebar-clip">
        <div className="visual-sidebar-surface" style={{ width }} inert={hidden ? true : undefined}>
          {children}
        </div>
      </div>
      {!hidden && resize}
    </aside>
  );
}

function statusIcon(tone: VisualCardStatus["tone"]): IconName | undefined {
  if (tone === "working") return "status-working";
  if (tone === "blocked") return "status-blocked";
  if (tone === "error") return "status-error";
  if (tone === "done") return "status-done";
  return undefined;
}

function metadataAgentText(agent: VisualTaskAgent): string {
  const identity =
    agent.model !== undefined && agent.provider !== undefined
      ? `${agent.provider}/${agent.model}`
      : (agent.model ?? agent.provider);
  return identity === undefined ? agent.kind : `${agent.kind} · ${identity}`;
}

function metadataFacts(row: VisualTaskRow): TooltipMetadataFact[] {
  const { metadata, status } = row;
  const agent = metadata.agent?.kind === "shell" ? undefined : metadata.agent;
  const error = status?.tone === "error" ? (status.message ?? "Error") : undefined;
  return [
    { icon: "project", value: metadata.project, truncate: true },
    ...(metadata.branch === undefined ? [] : [{ icon: "branch" as const, value: metadata.branch }]),
    ...(agent === undefined
      ? []
      : [
          {
            icon: "agent" as const,
            value: metadataAgentText(agent),
            truncate: true,
          },
        ]),
    ...(error === undefined
      ? []
      : [{ icon: "status-error" as const, value: error, tone: "error" as const }]),
  ];
}

function TaskMetadataTooltip({
  row,
  open,
  onOpenChange: setOpen,
  children,
}: {
  row: VisualTaskRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactElement;
}) {
  // A hover card does not follow a list scroll: close it so it cannot sit over the wrong row.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [open, setOpen]);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger render={children} />
      <TooltipContent variant="metadata" side="right" align="start" sideOffset={8}>
        <TooltipMetadata title={row.title} facts={metadataFacts(row)} />
      </TooltipContent>
    </Tooltip>
  );
}

export interface VisualTaskCardProps {
  row: VisualTaskRow;
  selected: boolean;
  onSelect: (id: string) => void;
  onNavigate: (id: string, direction: -1 | 1) => void;
  /**
   * Settle, or unsettle a settled task. Absent in a host with no task store: the slot then keeps
   * the status instead of offering an action that could not run.
   */
  onToggleSettle?: (() => void) | undefined;
  /** The row's secondary actions; absent in a host that has no task store to act on. */
  menu?: ReactNode | undefined;
  /** The menu took the keyboard; the shell's transient copy confirmation can go. */
  onMenuOpen?: (() => void) | undefined;
}

/** One 52 px, two-line task card. Selection stays a click; details open on hover and keyboard focus. */
export function VisualTaskCard({
  row,
  selected,
  onSelect,
  onNavigate,
  onToggleSettle,
  menu,
  onMenuOpen,
}: VisualTaskCardProps) {
  const { status, settled = false } = row;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const icon = status === undefined ? undefined : statusIcon(status.tone);
  const settleLabel = settled ? "Unsettle task" : "Settle task";

  const hit = (
    <button
      type="button"
      className="visual-task-card-hit"
      data-task-id={row.id}
      aria-current={selected ? "true" : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(row.id)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          onNavigate(row.id, 1);
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onNavigate(row.id, -1);
        }
      }}
    >
      <span className="visual-task-project-row">
        <span className="visual-project-avatar" aria-hidden="true">
          {row.projectInitial}
        </span>
        <span className="visual-task-project">{row.project}</span>
      </span>
      <span className="visual-task-title">{row.title}</span>
    </button>
  );

  return (
    <div
      className="visual-task-card"
      data-selected={selected ? "true" : undefined}
      data-settled={settled ? "true" : undefined}
    >
      {menu === undefined ? (
        <TaskMetadataTooltip row={row} open={tooltipOpen} onOpenChange={setTooltipOpen}>
          {hit}
        </TaskMetadataTooltip>
      ) : (
        // The tooltip's trigger wraps the context-menu trigger so the hit button keeps both the
        // metadata tooltip and the row menu (Shift+F10, the menu key and right-click).
        <ContextMenu.Root
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) {
              // A menu and the metadata card never stack; the mouse path opens the menu first.
              setTooltipOpen(false);
              onMenuOpen?.();
            }
          }}
        >
          <TaskMetadataTooltip
            row={row}
            open={!menuOpen && tooltipOpen}
            onOpenChange={(open) => setTooltipOpen(menuOpen ? false : open)}
          >
            <ContextMenu.Trigger render={hit} />
          </TaskMetadataTooltip>
          <RowMenuPopup label={`Task actions for ${row.title}`} skin="visual">
            {menu}
          </RowMenuPopup>
        </ContextMenu.Root>
      )}
      <div className="visual-task-slot">
        {status !== undefined && (
          <span
            className="visual-task-status"
            data-tone={status.tone}
            data-muted={status.muted === true ? "true" : undefined}
          >
            {icon !== undefined && <Icon name={icon} size="row" />}
            {status.label !== undefined && (
              <span className="visual-task-status-label">{status.label}</span>
            )}
            {status.time !== undefined && (
              <span className="visual-task-status-time">{status.time}</span>
            )}
          </span>
        )}
        <span className="visual-task-slot-action">
          {onToggleSettle !== undefined && (
            <CompactTooltip label={settleLabel}>
              <button
                type="button"
                className="visual-task-action"
                aria-label={settleLabel}
                onClick={onToggleSettle}
              >
                <Icon name={settled ? "unsettle" : "settle"} />
              </button>
            </CompactTooltip>
          )}
        </span>
      </div>
    </div>
  );
}
