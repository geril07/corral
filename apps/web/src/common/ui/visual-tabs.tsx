import type { AgentStatus, Session } from "@corral/protocol/rpc";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { AgentIcon } from "./agent-icon.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu.tsx";
import { Hint } from "./hint.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { RowMenu } from "./row-menu.tsx";
import { StatusGlyph } from "./status-glyph.tsx";
import { VisualResizeHandle } from "./visual-shell.tsx";

/** The tab's kind decides its glyph and whether it carries a number or status. */
export type VisualTabKind = "session" | "file" | "draft";

export interface VisualTabItem {
  id: string;
  kind: VisualTabKind;
  label: string;
  /** The state-bearing accessible name; the visible label stays short. */
  ariaLabel?: string | undefined;
  /** The context-menu name, e.g. `Session actions for shell`. */
  menuLabel?: string | undefined;
  /** Session and draft tabs carry 1–9 inside their group; file tabs carry none. */
  number?: number | undefined;
  agentKind?: Session["kind"] | undefined;
  status?: AgentStatus | undefined;
  selected: boolean;
  /** The primary session is not a closable view; files and drafts are. */
  canClose: boolean;
  /** The whole label and the session's state, when the label clips. */
  title?: string | undefined;
  /** The pane this tab controls; both groups use one pane per group. */
  paneId: string;
  /** Secondary actions for a session tab; rendered by the owning module. */
  menu?: ReactNode | undefined;
}

export type VisualTabGroup = "main" | "companion";

export interface VisualTabDrop {
  id: string;
  group: VisualTabGroup;
  over?: string;
  after?: boolean;
}

interface TabDragState {
  active: string | undefined;
  target: VisualTabDrop | undefined;
  /** The pointer is over the column a drop gives the other group, strip row included. */
  zone: boolean;
}

const IDLE_DRAG: TabDragState = { active: undefined, target: undefined, zone: false };

/** The column is its own element, so the zone comes from its box rather than a second definition. */
const TabDragContext = createContext<{
  drag: TabDragState;
  zoneRef: RefObject<HTMLDivElement | null>;
}>({ drag: IDLE_DRAG, zoneRef: { current: null } });

/** Where the pointer is now: the activator it went down at plus the drag's own translation. */
function pointerOf(event: DragMoveEvent | DragEndEvent): { x: number; y: number } | undefined {
  const activator = event.activatorEvent;
  if (!(activator instanceof PointerEvent)) return undefined;
  return { x: activator.clientX + event.delta.x, y: activator.clientY + event.delta.y };
}

function dropTarget(event: DragMoveEvent | DragEndEvent): VisualTabDrop | undefined {
  const { active, over } = event;
  if (over === null) return undefined;
  const group = over.data.current?.["group"];
  if (group !== "main" && group !== "companion") return undefined;
  if (over.data.current?.["edge"] === true) return { id: String(active.id), group };
  const moving = active.rect.current.translated;
  if (moving === null) return undefined;
  return {
    id: String(active.id),
    group,
    over: String(over.id),
    after: moving.left + moving.width / 2 >= over.rect.left + over.rect.width / 2,
  };
}

/** Pointer dragging is shared by both strips; keyboard users have the same actions in tab menus. */
function VisualTabDrag({
  onDrop,
  children,
}: {
  onDrop: (drop: VisualTabDrop) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [drag, setDrag] = useState<TabDragState>(IDLE_DRAG);
  const [label, setLabel] = useState("");
  const zoneRef = useRef<HTMLDivElement>(null);
  const context = useMemo(() => ({ drag, zoneRef }), [drag]);
  // A drop on a tab is a reorder, so the tab wins the drop; the column keeps painting, otherwise
  // crossing the strip inside it would blink the preview away.
  const inZone = (event: DragMoveEvent | DragEndEvent) => {
    const box = zoneRef.current?.getBoundingClientRect();
    const point = pointerOf(event);
    if (box === undefined || point === undefined) return false;
    return (
      point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
    );
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={({ active }) => {
        setLabel(String(active.data.current?.["label"] ?? ""));
        setDrag({ active: String(active.id), target: undefined, zone: false });
      }}
      onDragMove={(event) =>
        setDrag({
          active: String(event.active.id),
          target: dropTarget(event),
          zone: inZone(event),
        })
      }
      onDragEnd={(event) => {
        const target = dropTarget(event);
        setDrag(IDLE_DRAG);
        if (target !== undefined) onDrop(target);
      }}
      onDragCancel={() => setDrag(IDLE_DRAG)}
    >
      <TabDragContext.Provider value={context}>{children}</TabDragContext.Provider>
      <DragOverlay dropAnimation={null}>
        {drag.active === undefined ? null : (
          <div className="visual-tab-drag-overlay" aria-hidden="true">
            {label}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * The column the other group will take: the zone is the box it paints, strip row included, so a
 * drop on its strip places the tab there instead of moving it in its own.
 */
function VisualTabDropEdge({ group }: { group: VisualTabGroup }) {
  const { drag, zoneRef } = useContext(TabDragContext);
  const { setNodeRef } = useDroppable({
    id: `group:${group}`,
    data: { group, edge: true },
    disabled: drag.active === undefined,
  });
  return (
    <div
      ref={(node) => {
        zoneRef.current = node;
        setNodeRef(node);
      }}
      className="visual-tab-drop-edge"
      data-side={group === "main" ? "left" : "right"}
      data-visible={drag.zone ? "true" : undefined}
      aria-hidden="true"
    />
  );
}

export function VisualWorkspaceGroups({
  main,
  companion,
  mainVisible,
  companionVisible,
  expanded,
  width,
  min,
  max,
  onResize,
  onFocusGroup,
  onDrop,
}: {
  main: ReactNode;
  companion: ReactNode;
  mainVisible: boolean;
  companionVisible: boolean;
  /** The group occupying the whole working area, if any: a drop then expands its target. */
  expanded: VisualTabGroup | null;
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onFocusGroup: (group: VisualTabGroup) => void;
  onDrop: (drop: VisualTabDrop) => void;
}) {
  const split = mainVisible && companionVisible;
  return (
    <div
      className="visual-workspace-groups"
      data-split={split ? "true" : undefined}
      // The drop preview reads the width the split will give the companion, split or not.
      data-drop-full={expanded === null ? undefined : "true"}
      style={{ "--group-companion-width": `${width}px` } as CSSProperties}
    >
      <VisualTabDrag onDrop={onDrop}>
        <div
          className="visual-workspace-group"
          data-hidden={mainVisible ? undefined : "true"}
          aria-hidden={mainVisible ? undefined : true}
          inert={mainVisible ? undefined : true}
          onFocusCapture={() => onFocusGroup("main")}
        >
          {main}
        </div>
        <div
          className="visual-workspace-group visual-workspace-group-companion"
          data-hidden={companionVisible ? undefined : "true"}
          style={split ? { width } : undefined}
          aria-hidden={companionVisible ? undefined : true}
          inert={companionVisible ? undefined : true}
          onFocusCapture={() => onFocusGroup("companion")}
        >
          {companion}
        </div>
        {!split && <VisualTabDropEdge group={mainVisible ? "companion" : "main"} />}
      </VisualTabDrag>
      {split && (
        <VisualResizeHandle
          className="visual-split-handle"
          label="Resize companion group"
          reverse
          width={width}
          min={min}
          max={max}
          onResize={onResize}
        />
      )}
    </div>
  );
}

const GLYPH: Readonly<Record<Exclude<VisualTabKind, "session">, IconName>> = {
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
 * shares the trailing 20 px slot and appears on hover or keyboard focus only. `add` is a sibling
 * after the tab list inside the scroller, so it follows the last tab and may scroll out; the
 * tablist itself holds exactly the tabs, and an empty strip has no add control to follow.
 */
export function VisualTabStrip({
  label,
  items,
  onSelect,
  onClose,
  add,
  actions,
  dragGroup,
  position = "top",
}: {
  label: string;
  items: readonly VisualTabItem[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  add?: ReactNode;
  actions?: ReactNode;
  dragGroup?: VisualTabGroup;
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
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="visual-tab-list" role="tablist" aria-label={label}>
            {dragGroup === undefined ? (
              items.map((item) => (
                <div
                  key={item.id}
                  className="visual-tab"
                  data-selected={item.selected ? "true" : undefined}
                >
                  <TabCell item={item} onSelect={onSelect} onClose={onClose} onStep={step} />
                </div>
              ))
            ) : (
              <SortableContext
                items={items.map((item) => item.id)}
                strategy={horizontalListSortingStrategy}
              >
                {items.map((item) => (
                  <SortableTabCell
                    key={item.id}
                    item={item}
                    group={dragGroup}
                    onSelect={onSelect}
                    onClose={onClose}
                    onStep={step}
                  />
                ))}
              </SortableContext>
            )}
          </div>
          {add !== undefined && add !== null && items.length > 0 && (
            <div className="visual-tab-add">{add}</div>
          )}
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
      {actions}
    </div>
  );
}

interface TabCellProps {
  item: VisualTabItem;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onStep: (id: string, step: "next" | "previous" | "first" | "last") => void;
}

function TabCell({ item, onSelect, onClose, onStep }: TabCellProps) {
  return (
    <>
      {item.menu === undefined ? (
        <TabButton item={item} onSelect={onSelect} onStep={onStep} />
      ) : (
        <RowMenu
          label={item.menuLabel ?? item.label}
          skin="visual"
          trigger={
            <span className="visual-tab-trigger">
              <TabButton item={item} onSelect={onSelect} onStep={onStep} />
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
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onClose(item.id)}
        >
          <Icon name="close" />
        </button>
      )}
    </>
  );
}

function SortableTabCell(props: TabCellProps & { group: VisualTabGroup }) {
  const { item, group } = props;
  const { drag } = useContext(TabDragContext);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { group, label: item.label },
  });
  const target = drag.target?.over === item.id && drag.active !== item.id ? drag.target : undefined;
  return (
    <div
      ref={setNodeRef}
      className="visual-tab"
      data-selected={item.selected ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      data-drop={target === undefined ? undefined : target.after ? "after" : "before"}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      {...listeners}
    >
      <TabCell {...props} />
    </div>
  );
}

/**
 * The strip's add control. With `onAdd` it is a split control as browsers have beside the last
 * tab: the plus itself is the common action, and the adjacent chevron opens the menu beside it.
 * Without `onAdd` the whole control opens the menu, which is what the empty workspace repeats.
 */
export function VisualAddMenu({
  label,
  tooltip,
  menuLabel,
  onAdd,
  children,
}: {
  label: string;
  /** The compact hint with the two prefix chords; the trigger's name stays the short label. */
  tooltip?: ReactNode;
  /** The chevron's name when `onAdd` splits the control. */
  menuLabel?: string;
  /** The plain click; without it the whole control opens the menu. */
  onAdd?: (() => void) | undefined;
  children: ReactNode;
}) {
  if (onAdd === undefined) {
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
        <DropdownMenuContent align="end" skin="visual">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <Hint content={tooltip}>
      <span className="visual-add-split">
        <button type="button" className="visual-icon-button" aria-label={label} onClick={onAdd}>
          <Icon name="add" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="visual-icon-button visual-add-menu"
                aria-label={menuLabel ?? label}
              >
                <Icon name="collapse" />
              </button>
            }
          />
          <DropdownMenuContent align="end" skin="visual">
            {children}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </Hint>
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
