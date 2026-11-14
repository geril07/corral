import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { Toolbar } from "@base-ui/react/toolbar";
import { CheckIcon, SearchIcon } from "lucide-react";
import { useEnterGuard } from "../hooks/use-enter-guard.ts";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { AgentKind } from "@corral/protocol/rpc";
import { AgentIcon } from "./agent-icon.tsx";
import { Button } from "./button.tsx";
import { Hint } from "./hint.tsx";
import { Icon } from "./icon.tsx";
import { FormError, TaskDialog, useTaskFinalFocus } from "./task-dialog.tsx";
import { Dialog, DialogContent, DialogTitle } from "./dialog.tsx";
import { useTruncatedText } from "./truncated-text.tsx";

export interface PickerInstance {
  key: string;
  kind: AgentKind;
  name: string;
  detail?: string | undefined;
  badge?: string | undefined;
}

export interface PickerModel {
  key: string;
  name: string;
  provider?: string | undefined;
  detail?: string | undefined;
  current?: boolean | undefined;
  /** The configured default for this instance, marked in the model column. */
  default?: boolean | undefined;
  favorite?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Reported capabilities for this model, when known. */
  levels?: readonly string[] | undefined;
}

/** One virtualized row: a provider heading or a model. Headings keep their own height. */
type PickerRow =
  | { type: "group"; key: string; provider: string }
  | { type: "model"; key: string; model: PickerModel; index: number };

const NO_LEVELS: readonly string[] = [];
const SKELETON_ROWS = [0, 1, 2];

function Name({ name, className }: { name: string; className?: string | undefined }) {
  const { observe, clipped } = useTruncatedText(name);
  return (
    <span
      ref={observe}
      className={className ?? "min-w-0 flex-1 truncate"}
      title={clipped ? name : undefined}
    >
      {name}
    </span>
  );
}

/** One compact control, whether the chosen model came from config or a running driver. */
export function ModelPickerButton({
  kind,
  label,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & { kind: AgentKind; label: string }) {
  return (
    <Button variant="ghost" size="sm" layout="model" {...props}>
      <AgentIcon kind={kind} size="chrome" />
      <Name name={label} />
      <Icon name="collapse" size="chrome" />
    </Button>
  );
}

export interface ModelPickerProps {
  title: string;
  anchor?: RefObject<HTMLElement | null> | undefined;
  instances: readonly PickerInstance[];
  instance: string;
  onInstance: (key: string) => void;
  models: readonly PickerModel[];
  onModel: (key: string) => void;
  levels?: readonly string[] | undefined;
  level?: string | null | undefined;
  onLevel?: ((level: string) => void) | undefined;
  /** Atomically select a different candidate and one of its reported levels. */
  onModelLevel?: ((key: string, level: string) => void) | undefined;
  modelName?: string | undefined;
  /** The chosen model's levels have not been reported yet; the column shows skeletons. */
  levelsPending?: boolean | undefined;
  /** The catalog or shared preferences are still loading; the body is busy. */
  loading?: boolean | undefined;
  error?: string | undefined;
  busy?: boolean | undefined;
  /** A stable bar under the columns; the new-launch view choice. It never carries status. */
  footer?: React.ReactNode;
  focus?: "instance" | "search" | "thinking" | undefined;
  onQuickChoice?: ((index: number) => void) | undefined;
  onInstanceEnter?: (() => void) | undefined;
  restoreFocus?: "dialog" | "anchor" | "composer" | undefined;
  /** The return target when this picker renders as its own dialog, e.g. nested in another dialog. */
  finalFocus?: React.ComponentProps<typeof TaskDialog>["finalFocus"];
  onClose: () => void;
}

/** One modal regardless of whether the opener has an anchor. */
export function ModelPicker({ title, anchor, onClose, ...props }: ModelPickerProps) {
  const search = useRef<HTMLInputElement>(null);
  const instance = useRef<HTMLDivElement>(null);
  const thinking = useRef<HTMLButtonElement>(null);
  const defaultFinalFocus = useTaskFinalFocus(props.restoreFocus === "composer");
  const [query, setQuery] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) onClose();
      }}
    >
      <DialogContent
        className="model-picker-dialog visual-dialog-anchored"
        padding="none"
        showCloseButton={false}
        initialFocus={
          props.focus === "instance" ? instance : props.focus === "thinking" ? thinking : search
        }
        finalFocus={
          props.finalFocus ??
          (props.restoreFocus === "anchor" && anchor ? anchor : defaultFinalFocus)
        }
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <PickerContent
          {...props}
          title={title}
          onClose={onClose}
          searchRef={search}
          instanceRef={instance}
          thinkingRef={thinking}
          query={query}
          onQuery={setQuery}
        />
      </DialogContent>
    </Dialog>
  );
}

function PickerContent({
  instances,
  instance,
  onInstance,
  models,
  onModel,
  levels = NO_LEVELS,
  level,
  onLevel,
  onModelLevel,
  modelName,
  levelsPending,
  loading,
  error,
  busy,
  footer,
  onQuickChoice,
  onInstanceEnter,
  searchRef,
  instanceRef,
  thinkingRef,
  query,
  onQuery,
}: ModelPickerProps & {
  query: string;
  onQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  instanceRef: RefObject<HTMLDivElement | null>;
  thinkingRef: RefObject<HTMLButtonElement | null>;
}) {
  const guard = useEnterGuard();
  const modelList = useRef<LegendListRef>(null);
  const instanceList = useRef<LegendListRef>(null);
  const levelsRoot = useRef<HTMLDivElement>(null);
  const wantedLevel = useRef<string | undefined>(undefined);
  const id = useId();
  const instanceIndex = instances.findIndex((item) => item.key === instance);
  const tabStop = instanceIndex >= 0 ? instance : instances[0]?.key;
  useEffect(() => {
    if (instanceIndex >= 0)
      void instanceList.current?.scrollToIndex({ index: instanceIndex, animated: false });
  }, [instanceIndex]);
  // Arrow keys move the selection, so the keyboard has to follow it: focus stays on the previous
  // radio otherwise, and Space would reactivate that instance. The target can mount a frame after
  // the selection renders (the list scrolls it in), so the focus retries until it is there.
  const focusInstance = useRef<string | null>(null);
  useEffect(() => {
    if (focusInstance.current !== instance) return undefined;
    const index = instances.findIndex((item) => item.key === instance);
    if (index < 0) return undefined;
    let frame = 0;
    let attempt = 0;
    const focus = () => {
      if (focusInstance.current !== instance) return;
      const radio = document.getElementById(`${id}-instance-${index}`);
      if (!(radio instanceof HTMLButtonElement)) {
        if (attempt++ < 10) frame = requestAnimationFrame(focus);
        return;
      }
      focusInstance.current = null;
      radio.focus();
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, [id, instance, instances]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = models.filter((model) => {
    const text = `${model.name} ${model.provider ?? ""} ${model.detail ?? ""}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  // Provider headings are rows of their own, so a heading and a model never share one height.
  const rows: PickerRow[] = [];
  visible.forEach((model, index) => {
    // Favorites are ordered ahead of the provider groups, so one provider can head more than one
    // run. The run's first model index keeps each heading key distinct.
    if (model.provider && model.provider !== visible[index - 1]?.provider)
      rows.push({
        type: "group",
        key: `group:${model.provider}:${index}`,
        provider: model.provider,
      });
    rows.push({ type: "model", key: `model:${model.key}`, model, index });
  });
  const active = visible.findIndex((model) => model.key === highlight);
  const selected = visible[active] ?? visible.find((model) => model.current);
  const selectedLevels = selected?.current || !selected ? levels : (selected.levels ?? NO_LEVELS);
  const canChangeLevel = !selected || !!selected.current;
  const canChooseCandidateLevel =
    !!selected && !selected.current && !selected.disabled && !!onModelLevel;
  const selectedName = selected?.name ?? modelName ?? "";
  // A chosen level keeps the picker open: focus stays there, and returns to it once an in-flight
  // apply has stopped disabling the column.
  useEffect(() => {
    const wanted = wantedLevel.current;
    if (busy || wanted === undefined) return;
    const button = [
      ...(levelsRoot.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ].find((candidate) => candidate.dataset["level"] === wanted);
    if (!button || button.disabled) return;
    wantedLevel.current = undefined;
    button.focus();
  }, [busy]);
  function moveModel(direction: number) {
    if (!visible.length) return;
    let index = active < 0 ? (direction > 0 ? -1 : visible.length) : active;
    for (let count = 0; count < visible.length; count++) {
      index = (index + direction + visible.length) % visible.length;
      if (!visible[index]?.disabled) {
        setHighlight(visible[index]!.key);
        const row = rows.findIndex((item) => item.type === "model" && item.index === index);
        if (row >= 0) void modelList.current?.scrollToIndex({ index: row, animated: false });
        break;
      }
    }
  }
  function moveInstance(direction: number) {
    if (busy || !instances.length) return;
    const index = Math.max(
      0,
      instances.findIndex((item) => item.key === instance),
    );
    const next = (index + direction + instances.length) % instances.length;
    focusInstance.current = instances[next]!.key;
    onInstance(instances[next]!.key);
    void instanceList.current?.scrollToIndex({ index: next, animated: false });
  }
  return (
    <div
      className="model-picker-body"
      aria-busy={busy || levelsPending || loading || undefined}
      onKeyDown={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !event.shiftKey &&
          /^[1-9]$/.test(event.key)
        ) {
          const model = visible[Number(event.key) - 1];
          if (model && !model.disabled && !busy) {
            event.preventDefault();
            onModel(model.key);
          }
        }
      }}
    >
      <div className="model-picker-columns">
        <div
          ref={instanceRef}
          role="radiogroup"
          aria-label="Instances"
          tabIndex={0}
          className="model-picker-rail"
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              event.shiftKey
            )
              return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveInstance(event.key === "ArrowDown" ? 1 : -1);
            }
            if (event.key === "Enter" && onInstanceEnter && !busy) {
              event.preventDefault();
              onInstanceEnter();
            }
            if (/^[1-9]$/.test(event.key) && onQuickChoice && !busy) {
              event.preventDefault();
              onQuickChoice(Number(event.key) - 1);
            }
          }}
        >
          <LegendList
            ref={instanceList}
            data={instances}
            alwaysRender={{ keys: instanceIndex >= 0 ? [instance] : [] }}
            extraData={`${instance}:${!!busy}`}
            recycleItems={false}
            keyExtractor={(item: PickerInstance) => item.key}
            estimatedItemSize={40}
            estimatedListSize={{ width: 44, height: 340 }}
            className="model-picker-rail-list"
            renderItem={({ item, index }: { item: PickerInstance; index: number }) => (
              // The rail shows a glyph and a badge, so the instance's name and detail are a hint:
              // hover and keyboard focus both reveal it, unlike a native `title`.
              <Hint content={[item.name, item.detail].filter(Boolean).join(" · ")} side="right">
                <button
                  type="button"
                  role="radio"
                  id={`${id}-instance-${index}`}
                  aria-checked={item.key === instance}
                  aria-label={item.name}
                  disabled={busy}
                  tabIndex={item.key === tabStop ? 0 : -1}
                  className="model-picker-instance"
                  onClick={() => onInstance(item.key)}
                >
                  <AgentIcon kind={item.kind} size="chrome" />
                  {item.badge && (
                    <span aria-hidden="true" className="model-picker-badge">
                      {item.badge}
                    </span>
                  )}
                </button>
              </Hint>
            )}
          />
        </div>
        <div className="model-picker-models">
          <div className="model-picker-search">
            <SearchIcon aria-hidden="true" className="model-picker-search-icon" />
            <input
              ref={searchRef}
              aria-label="Search models"
              placeholder="Search models…"
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={`${id}-model-list`}
              aria-activedescendant={active >= 0 ? `${id}-model-${active}` : undefined}
              value={query}
              autoComplete="off"
              spellCheck={false}
              className="model-picker-search-input"
              onChange={(event) => {
                onQuery(event.target.value);
                setHighlight(null);
              }}
              onCompositionStart={guard.start}
              onCompositionEnd={guard.end}
              onKeyDown={(event) => {
                guard.noteKey(event.key);
                if (event.key === "Enter" && guard.isComposition(event)) {
                  guard.consume();
                  event.preventDefault();
                  return;
                }
                if (
                  event.nativeEvent.isComposing ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.altKey ||
                  event.shiftKey
                )
                  return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveModel(event.key === "ArrowDown" ? 1 : -1);
                }
                if (event.key === "Enter") {
                  const model = visible[active] ?? visible.find((item) => !item.disabled);
                  if (model && !model.disabled && !busy) {
                    event.preventDefault();
                    onModel(model.key);
                  }
                }
              }}
            />
          </div>
          <LegendList
            ref={modelList}
            data={rows}
            alwaysRender={{
              keys: active >= 0 ? [`model:${visible[active]!.key}`] : [],
            }}
            extraData={`${query}:${highlight ?? ""}:${!!busy}`}
            recycleItems={false}
            keyExtractor={(item: PickerRow) => item.key}
            estimatedItemSize={34}
            estimatedListSize={{ width: 356, height: 348 }}
            className="model-picker-list"
            role="listbox"
            id={`${id}-model-list`}
            aria-label="Models"
            renderItem={({ item }: { item: PickerRow }) =>
              item.type === "group" ? (
                <div role="presentation" className="model-picker-provider">
                  {item.provider}
                </div>
              ) : (
                <div
                  id={`${id}-model-${item.index}`}
                  role="option"
                  aria-selected={item.model.key === selected?.key}
                  aria-posinset={item.index + 1}
                  aria-setsize={visible.length}
                  aria-disabled={!!busy || !!item.model.disabled}
                  aria-label={[
                    item.model.name,
                    item.model.provider,
                    item.model.detail,
                    item.model.default ? "Default" : null,
                    item.model.favorite ? "Favorite" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  aria-current={item.model.current ? "true" : undefined}
                  className="model-picker-option"
                  data-active={item.model.key === visible[active]?.key || undefined}
                  onMouseMove={() => setHighlight(item.model.key)}
                  onClick={() => {
                    if (!busy && !item.model.disabled) onModel(item.model.key);
                  }}
                >
                  <div className="model-picker-option-main">
                    <Name name={item.model.name} className="model-picker-option-name" />
                    {item.model.detail && (
                      <Name name={item.model.detail} className="model-picker-option-detail" />
                    )}
                  </div>
                  <div className="model-picker-option-tail">
                    {item.model.default && <span className="model-picker-default">Default</span>}
                    {item.model.favorite && (
                      <span aria-hidden="true" className="model-picker-star">
                        ★
                      </span>
                    )}
                    {item.index < 9 && !item.model.default && (
                      <kbd className="model-picker-keycap">Ctrl+{item.index + 1}</kbd>
                    )}
                    <span className="model-picker-check">
                      {item.model.current && (
                        <CheckIcon aria-hidden="true" className="model-picker-check-icon" />
                      )}
                    </span>
                  </div>
                </div>
              )
            }
          />
        </div>
        <div
          ref={levelsRoot}
          className="model-picker-thinking"
          role="group"
          aria-label="Thinking levels"
          aria-busy={levelsPending || undefined}
        >
          <div className="model-picker-thinking-head">
            <span className="model-picker-thinking-title">Thinking</span>
            {selectedName && <Name name={selectedName} className="model-picker-thinking-model" />}
          </div>
          {levelsPending ? (
            <div className="model-picker-level-skeletons" aria-hidden="true">
              {SKELETON_ROWS.map((row) => (
                <div key={row} className="model-picker-level-skeleton" />
              ))}
            </div>
          ) : selectedLevels.length > 0 ? (
            <Toolbar.Root
              orientation="vertical"
              aria-label="Thinking"
              className="model-picker-levels"
            >
              {selectedLevels.map((value, index) => (
                <Toolbar.Button
                  key={value}
                  ref={value === level || (!level && index === 0) ? thinkingRef : undefined}
                  type="button"
                  data-level={value}
                  className="model-picker-level"
                  aria-pressed={canChangeLevel && value === level}
                  disabled={busy || (canChangeLevel ? !onLevel : !canChooseCandidateLevel)}
                  onClick={(event) => {
                    wantedLevel.current = value;
                    event.currentTarget.focus();
                    if (canChangeLevel) onLevel?.(value);
                    else if (selected && canChooseCandidateLevel)
                      onModelLevel?.(selected.key, value);
                  }}
                >
                  <span className="model-picker-level-name">{value}</span>
                  {canChangeLevel && value === level && (
                    <CheckIcon aria-hidden="true" className="model-picker-level-check" />
                  )}
                </Toolbar.Button>
              ))}
            </Toolbar.Root>
          ) : (
            <div className="model-picker-levels-empty" aria-hidden="true" />
          )}
        </div>
      </div>
      {error && (
        <div className="model-picker-error">
          <FormError>{error}</FormError>
        </div>
      )}
      {footer && <div className="model-picker-footer">{footer}</div>}
    </div>
  );
}
