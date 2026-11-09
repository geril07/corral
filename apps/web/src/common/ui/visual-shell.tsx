import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./icon.tsx";

/** The compact tooltip's shortcut, split into the prefix chord and the action chord. */
export interface VisualShortcut {
  prefix: string;
  binding: string | null;
}

/** The status slot of a task card, already resolved from the primary session. */
export interface VisualCardStatus {
  tone: "working" | "blocked" | "error" | "done" | "neutral";
  /** Absent for a neutral card, which shows only its muted age. */
  label?: string | undefined;
  /** Absent when no trustworthy timestamp exists (Working has no reliable start). */
  time?: string | undefined;
  muted?: boolean | undefined;
  /** The agent's own sentence, shown in the metadata popover rather than the card. */
  message?: string | undefined;
}

/** Facts the metadata popover may show; every one came from the server. */
export interface VisualTaskMetadata {
  project: string;
  branch: string;
  workspace: string;
  agent?: string | undefined;
  status?: string | undefined;
  prompt?: string | undefined;
}

export interface VisualTaskRow {
  id: string;
  title: string;
  project: string;
  projectInitial: string;
  status?: VisualCardStatus | undefined;
  metadata: VisualTaskMetadata;
}

function Keycaps({ shortcut }: { shortcut: VisualShortcut }) {
  return (
    <span className="visual-keycaps" aria-hidden="true">
      <kbd className="visual-keycap">{shortcut.prefix}</kbd>
      {shortcut.binding !== null && <kbd className="visual-keycap">{shortcut.binding}</kbd>}
    </span>
  );
}

/** One dark compact tooltip: the action's name, an optional reason, and the live keymap. */
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
    <Tooltip.Provider delay={400}>
      <Tooltip.Root disableHoverablePopup>
        <Tooltip.Trigger render={children} />
        <Tooltip.Portal>
          <Tooltip.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={8}>
            <Tooltip.Popup className="visual-tooltip" role="tooltip">
              <span className="visual-tooltip-label">{label}</span>
              {reason !== undefined && <span className="visual-tooltip-reason">{reason}</span>}
              {shortcut !== undefined && <Keycaps shortcut={shortcut} />}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
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
  /** `floating` keeps the hidden sidebar's toggle inside the main surface's top edge. */
  placement?: "inline" | "floating" | undefined;
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
  placement = "inline",
}: VisualIconButtonProps) {
  const disabled = disabledReason !== undefined;
  return (
    <CompactTooltip label={label} reason={disabledReason} shortcut={shortcut}>
      <button
        type="button"
        className={`visual-icon-button${placement === "floating" ? " visual-main-toggle" : ""}`}
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
  disabledReason,
  shortcut,
}: {
  label: string;
  disabledReason: string;
  shortcut?: VisualShortcut | undefined;
}) {
  return (
    <CompactTooltip label={label} reason={disabledReason} shortcut={shortcut}>
      <button type="button" className="visual-search-row" aria-disabled="true">
        <Icon name="find" />
        <span className="visual-search-label">{label}</span>
      </button>
    </CompactTooltip>
  );
}

/** The sidebar's drag edge: pointer drag and arrow keys, bounded by the caller. */
export function VisualResizeHandle({
  width,
  min,
  max,
  onResize,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
}) {
  const keyStep = 16;
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
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
  children,
}: {
  width: number;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <aside
      id="visual-sidebar"
      className="visual-shell-sidebar"
      data-hidden={hidden ? "true" : undefined}
      style={{ width }}
    >
      {children}
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

function metadataFacts(row: VisualTaskRow): { label: string; value: string }[] {
  return [
    { label: "Project", value: row.metadata.project },
    { label: "Branch", value: row.metadata.branch },
    { label: "Workspace", value: row.metadata.workspace },
    ...(row.metadata.agent === undefined ? [] : [{ label: "Agent", value: row.metadata.agent }]),
    ...(row.metadata.status === undefined ? [] : [{ label: "Status", value: row.metadata.status }]),
  ];
}

function MetadataRows({ row }: { row: VisualTaskRow }) {
  return (
    <>
      {metadataFacts(row).map((fact) => (
        <div className="visual-metadata-row" key={fact.label}>
          <dt className="visual-metadata-label">{fact.label}</dt>
          <dd className="visual-metadata-value">{fact.value}</dd>
        </div>
      ))}
    </>
  );
}

export interface VisualTaskCardProps {
  row: VisualTaskRow;
  selected: boolean;
  onSelect: (id: string) => void;
  onNavigate: (id: string, direction: -1 | 1) => void;
  /** Why the settle action cannot run; the card always swaps its status for it on hover/focus. */
  settleReason: string;
}

/** One 52 px, two-line task card. Card selection and the metadata popover are separate actions. */
export function VisualTaskCard({
  row,
  selected,
  onSelect,
  onNavigate,
  settleReason,
}: VisualTaskCardProps) {
  const card = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const { status } = row;
  const icon = status === undefined ? undefined : statusIcon(status.tone);

  const openMetadata = (focus: HTMLElement | null) => {
    previousFocus.current = focus;
    setMetadataOpen(true);
  };
  const closeMetadata = () => {
    setMetadataOpen(false);
    previousFocus.current?.focus();
    previousFocus.current = null;
  };

  return (
    <div
      ref={card}
      className="visual-task-card"
      data-selected={selected ? "true" : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        openMetadata(document.activeElement instanceof HTMLElement ? document.activeElement : null);
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === "F10" && event.shiftKey) {
          event.preventDefault();
          openMetadata(event.target instanceof HTMLElement ? event.target : null);
        }
      }}
    >
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
          <CompactTooltip label="Settle task" reason={settleReason}>
            <button
              type="button"
              className="visual-task-action"
              aria-label="Settle task"
              aria-disabled="true"
            >
              <Icon name="settle" />
            </button>
          </CompactTooltip>
        </span>
      </div>
      <Popover.Root
        open={metadataOpen}
        onOpenChange={(next) => {
          if (next) setMetadataOpen(true);
          else closeMetadata();
        }}
      >
        <Popover.Portal>
          <Popover.Positioner
            anchor={card}
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={8}
          >
            <Popover.Popup className="visual-metadata-popover" aria-label="Task details">
              <span className="visual-metadata-project">{row.project}</span>
              <span className="visual-metadata-title">{row.title}</span>
              <dl className="visual-metadata-rows">
                <MetadataRows row={row} />
              </dl>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
