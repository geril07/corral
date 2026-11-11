import type { AgentStatus, Session } from "@corral/protocol/rpc";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AgentIcon } from "./agent-icon.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu.tsx";
import { Hint } from "./hint.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { RowMenu } from "./row-menu.tsx";
import { StatusGlyph } from "./status-glyph.tsx";

/** The tab's kind decides its glyph and whether it carries a number or status. */
export type VisualTabKind = "session" | "changes" | "file" | "draft";

export interface VisualTabItem {
  id: string;
  kind: VisualTabKind;
  label: string;
  /** The state-bearing accessible name; the visible label stays short. */
  ariaLabel?: string | undefined;
  /** The context-menu name, e.g. `Session actions for shell 2`. */
  menuLabel?: string | undefined;
  /** Session tabs carry 1–9 inside their group; Changes and files carry none. */
  number?: number | undefined;
  agentKind?: Session["kind"] | undefined;
  status?: AgentStatus | undefined;
  selected: boolean;
  /** The primary session is not a closable view; Changes and files are. */
  canClose: boolean;
  /** The whole label and the session's state, when the label clips. */
  title?: string | undefined;
  /** The pane this tab controls; both groups use one pane per group. */
  paneId: string;
  /** Secondary actions for a session tab; rendered by the owning module. */
  menu?: ReactNode | undefined;
}

const GLYPH: Readonly<Record<Exclude<VisualTabKind, "session">, IconName>> = {
  changes: "changes",
  file: "file",
  draft: "task",
};

function TabGlyph({ item }: { item: VisualTabItem }) {
  if (item.kind !== "session") return <Icon name={GLYPH[item.kind]} />;
  const state = item.status?.state;
  if (state === "working" || state === "blocked" || state === "error" || state === "done")
    return <StatusGlyph state={state} size="default" />;
  return <AgentIcon kind={item.agentKind ?? "shell"} />;
}

function TabButton({
  item,
  onSelect,
  onStep,
}: {
  item: VisualTabItem;
  onSelect: (id: string) => void;
  onStep: (id: string, step: "next" | "previous" | "first" | "last") => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${item.id}`}
      className="visual-tab-main"
      aria-label={item.ariaLabel ?? item.label}
      aria-selected={item.selected}
      aria-controls={item.paneId}
      tabIndex={item.selected ? 0 : -1}
      title={item.title ?? item.label}
      data-tab-id={item.id}
      onClick={() => onSelect(item.id)}
      onKeyDown={(event) => {
        const step = (
          {
            ArrowRight: "next",
            ArrowLeft: "previous",
            Home: "first",
            End: "last",
          } as const
        )[event.key];
        if (step === undefined) return;
        event.preventDefault();
        onStep(item.id, step);
      }}
    >
      {item.number !== undefined && (
        <span className="visual-tab-number" aria-hidden="true">
          {item.number}
        </span>
      )}
      <span className="visual-tab-glyph" aria-hidden="true">
        <TabGlyph item={item} />
      </span>
      <span className="visual-tab-label">{item.label}</span>
    </button>
  );
}

/**
 * One working-area strip: 28 px tabs in a 40 px band, content-width down to 72 and then a
 * horizontal scroll with edge fades; the active tab is scrolled into view. The close control
 * shares the trailing 20 px slot and appears on hover or keyboard focus only.
 */
export function VisualTabStrip({
  label,
  items,
  onSelect,
  onClose,
  trailing,
  position = "top",
}: {
  label: string;
  items: readonly VisualTabItem[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  trailing?: ReactNode;
  position?: "top" | "bottom";
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const node = scroll.current;
    if (node === null) return;
    const start = node.scrollLeft > 1;
    const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setEdges((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const node = scroll.current;
    if (node === null) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [measure]);

  // A new tab changes the content width without resizing the viewport the observer watches.
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- item changes are the trigger
  useEffect(() => measure(), [items, measure]);

  const selectedId = items.find((item) => item.selected)?.id;
  useEffect(() => {
    if (selectedId === undefined) return;
    scroll.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  const moveFocus = (id: string) => {
    requestAnimationFrame(() => {
      scroll.current
        ?.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(id)}"]`)
        ?.focus();
    });
  };

  const step = (id: string, direction: "next" | "previous" | "first" | "last") => {
    if (items.length === 0) return;
    const index = items.findIndex((item) => item.id === id);
    const at =
      direction === "first"
        ? 0
        : direction === "last"
          ? items.length - 1
          : (Math.max(0, index) + (direction === "next" ? 1 : -1) + items.length) % items.length;
    const next = items[at];
    if (next === undefined) return;
    onSelect(next.id);
    moveFocus(next.id);
  };

  return (
    <div className="visual-tab-band" data-position={position}>
      <div className="visual-tab-viewport">
        <div
          className="visual-tab-scroll"
          ref={scroll}
          role="tablist"
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
        >
          {items.map((item) => (
            <div
              key={item.id}
              className="visual-tab"
              data-selected={item.selected ? "true" : undefined}
            >
              {item.menu === undefined ? (
                <TabButton item={item} onSelect={onSelect} onStep={step} />
              ) : (
                <RowMenu
                  label={item.menuLabel ?? item.label}
                  trigger={
                    <span className="visual-tab-trigger">
                      <TabButton item={item} onSelect={onSelect} onStep={step} />
                    </span>
                  }
                >
                  {item.menu}
                </RowMenu>
              )}
              {item.canClose && (
                <button
                  type="button"
                  className="visual-tab-close"
                  aria-label={`Close ${item.label} tab`}
                  title={`Close ${item.label} tab`}
                  tabIndex={-1}
                  onClick={() => onClose(item.id)}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
          ))}
        </div>
        <span
          className="visual-tab-fade"
          data-edge="start"
          data-visible={edges.start ? "true" : undefined}
          aria-hidden="true"
        />
        <span
          className="visual-tab-fade"
          data-edge="end"
          data-visible={edges.end ? "true" : undefined}
          aria-hidden="true"
        />
      </div>
      {trailing !== undefined && trailing !== null && (
        <div className="visual-tab-trailing">{trailing}</div>
      )}
    </div>
  );
}

/** The strip's trailing plus, opening the same compact menu the workspace uses elsewhere. */
export function VisualAddMenu({
  label,
  tooltip,
  children,
}: {
  label: string;
  /** The compact hint with the two prefix chords; the trigger's name stays the short label. */
  tooltip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <Hint content={tooltip}>
        <DropdownMenuTrigger
          render={
            <button type="button" className="visual-icon-button" aria-label={label}>
              <Icon name="add" />
            </button>
          }
        />
      </Hint>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A vertical split edge: a 1 px line with an 8 px pointer hit area. */
export function VisualSplitHandle({
  width,
  min,
  max,
  onResize,
  onResizeStart,
  onResizeEnd,
  label,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onResizeStart?: (() => void) | undefined;
  onResizeEnd?: (() => void) | undefined;
  label: string;
}) {
  const keyStep = 16;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="visual-split-handle"
      onPointerDown={(event) => {
        event.preventDefault();
        onResizeStart?.();
        const handle = event.currentTarget;
        const startX = event.clientX;
        const startWidth = width;
        const move = (moved: PointerEvent) => onResize(startWidth + (startX - moved.clientX));
        const stop = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", stop);
          handle.removeEventListener("pointercancel", stop);
          handle.removeEventListener("lostpointercapture", stop);
          if (handle.hasPointerCapture(event.pointerId))
            handle.releasePointerCapture(event.pointerId);
          onResizeEnd?.();
        };
        handle.setPointerCapture(event.pointerId);
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
        handle.addEventListener("lostpointercapture", stop);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onResize(width + keyStep);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onResize(width - keyStep);
        }
      }}
    />
  );
}

/**
 * The companion group's frame. Closing it keeps its contents mounted, like both references: the
 * frame narrows to zero and the fixed-width surface is clipped, so a terminal or chat store is
 * not torn down by hiding the group. `inert` keeps a hidden surface out of the keyboard.
 */
export function VisualCompanion({
  open,
  width,
  min,
  max,
  onResize,
  label,
  children,
}: {
  open: boolean;
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  label: string;
  children: ReactNode;
}) {
  const [resizing, setResizing] = useState(false);
  return (
    <aside
      className="visual-companion"
      data-open={open ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
      style={open ? { width } : undefined}
    >
      {open && (
        <VisualSplitHandle
          width={width}
          min={min}
          max={max}
          onResize={onResize}
          onResizeStart={() => setResizing(true)}
          onResizeEnd={() => setResizing(false)}
          label={label}
        />
      )}
      <div className="visual-companion-clip">
        <div
          className="visual-companion-surface"
          style={{ width }}
          inert={!open ? true : undefined}
          aria-hidden={!open ? "true" : undefined}
        >
          {children}
        </div>
      </div>
    </aside>
  );
}

/** A pane the tabs control; the id is what `aria-controls` names. */
export function VisualTabPanel({
  id,
  labelledBy,
  fill = false,
  children,
  panelRef,
}: {
  id: string;
  labelledBy?: string | undefined;
  fill?: boolean | undefined;
  children: ReactNode;
  panelRef?: RefObject<HTMLDivElement | null> | undefined;
}) {
  return (
    <div
      ref={panelRef}
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      className={fill ? "visual-tab-panel visual-tab-panel-fill" : "visual-tab-panel"}
    >
      {children}
    </div>
  );
}
