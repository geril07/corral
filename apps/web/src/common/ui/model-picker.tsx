import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { Toolbar } from "@base-ui/react/toolbar";
import { useEnterGuard } from "../hooks/use-enter-guard.ts";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { AgentKind } from "@corral/protocol/rpc";
import { AgentIcon } from "./agent-icon.tsx";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
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
  favorite?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Reported capabilities for this model, when known. */
  levels?: readonly string[] | undefined;
}

const NO_LEVELS: readonly string[] = [];

function Name({ name }: { name: string }) {
  const { observe, clipped } = useTruncatedText(name);
  return (
    <span ref={observe} className="min-w-0 flex-1 truncate" title={clipped ? name : undefined}>
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
  unavailable?: string | undefined;
  emptyMessage?: string | undefined;
  error?: string | undefined;
  busy?: boolean | undefined;
  nativeModel?:
    | {
        value: string;
        placeholder: string;
        onChange: (value: string) => void;
        onSubmit: () => void;
      }
    | undefined;
  footer?: React.ReactNode;
  focus?: "instance" | "search" | "thinking" | undefined;
  onQuickChoice?: ((index: number) => void) | undefined;
  onInstanceEnter?: (() => void) | undefined;
  restoreFocus?: "dialog" | "anchor" | "composer" | undefined;
  /** The return target when this picker renders as its own dialog, e.g. nested in another dialog. */
  finalFocus?: React.ComponentProps<typeof TaskDialog>["finalFocus"];
  suspended?: boolean | undefined;
  onClose: () => void;
}

/** One modal regardless of whether the opener has an anchor. */
export function ModelPicker({ title, anchor, onClose, ...props }: ModelPickerProps) {
  const search = useRef<HTMLInputElement>(null);
  const instance = useRef<HTMLDivElement>(null);
  const thinking = useRef<HTMLButtonElement>(null);
  const defaultFinalFocus = useTaskFinalFocus(props.restoreFocus === "composer");
  const [query, setQuery] = useState("");
  if (props.suspended) return null;
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
  unavailable,
  emptyMessage,
  error,
  busy,
  nativeModel,
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
  const id = useId();
  const instanceIndex = instances.findIndex((item) => item.key === instance);
  useEffect(() => {
    if (instanceIndex >= 0)
      void instanceList.current?.scrollToIndex({ index: instanceIndex, animated: false });
  }, [instanceIndex]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = models.filter((model) => {
    const text = `${model.name} ${model.provider ?? ""} ${model.detail ?? ""}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const active = visible.findIndex((model) => model.key === highlight);
  const selected = visible[active] ?? visible.find((model) => model.current);
  const selectedLevels = selected?.current || !selected ? levels : (selected.levels ?? NO_LEVELS);
  const canChangeLevel = !selected || !!selected.current;
  const canChooseCandidateLevel =
    !!selected && !selected.current && !selected.disabled && !!onModelLevel;
  function moveModel(direction: number) {
    if (!visible.length) return;
    let index = active < 0 ? (direction > 0 ? -1 : visible.length) : active;
    for (let count = 0; count < visible.length; count++) {
      index = (index + direction + visible.length) % visible.length;
      if (!visible[index]?.disabled) {
        setHighlight(visible[index]!.key);
        void modelList.current?.scrollToIndex({ index, animated: false });
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
    onInstance(instances[next]!.key);
    void instanceList.current?.scrollToIndex({ index: next, animated: false });
  }
  return (
    <div
      className="model-picker-body"
      aria-busy={busy}
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
          role="listbox"
          aria-label="agent"
          tabIndex={0}
          aria-activedescendant={
            instances.some((item) => item.key === instance)
              ? `${id}-instance-${instanceIndex}`
              : undefined
          }
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
            estimatedItemSize={44}
            estimatedListSize={{ width: 52, height: 480 }}
            className="h-full"
            renderItem={({ item, index }: { item: PickerInstance; index: number }) => (
              <button
                type="button"
                role="option"
                id={`${id}-instance-${index}`}
                aria-selected={item.key === instance}
                aria-posinset={index + 1}
                aria-setsize={instances.length}
                aria-label={item.name}
                title={[item.name, item.detail].filter(Boolean).join(" · ")}
                disabled={busy}
                tabIndex={-1}
                className="model-picker-instance"
                onClick={() => onInstance(item.key)}
              >
                <AgentIcon kind={item.kind} size="chrome" />
                {item.badge && <span className="model-picker-badge">{item.badge}</span>}
              </button>
            )}
          />
        </div>
        <div className="model-picker-models">
          <p className="m-0 flex shrink-0 px-2 pt-2 text-xs font-medium">
            <Name name={instances.find((item) => item.key === instance)?.name ?? ""} />
          </p>
          <Input
            ref={searchRef}
            aria-label="Search models"
            placeholder="Search models…"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-model-list`}
            aria-activedescendant={active >= 0 ? `${id}-model-${active}` : undefined}
            value={query}
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
          {visible.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              {query ? "No models match." : (emptyMessage ?? "No models reported.")}
            </p>
          )}
          <LegendList
            ref={modelList}
            data={visible}
            alwaysRender={{ keys: active >= 0 ? [visible[active]!.key] : [] }}
            extraData={`${query}:${highlight ?? ""}:${!!busy}`}
            recycleItems={false}
            keyExtractor={(item: PickerModel) => item.key}
            estimatedItemSize={48}
            estimatedListSize={{ width: 600, height: 480 }}
            className="model-picker-list"
            role="listbox"
            id={`${id}-model-list`}
            aria-label="Models"
            renderItem={({ item: model, index }: { item: PickerModel; index: number }) => (
              <div>
                {model.provider &&
                  (index === 0 || visible[index - 1]?.provider !== model.provider) && (
                    <div className="model-picker-provider">{model.provider}</div>
                  )}
                <div
                  id={`${id}-model-${index}`}
                  role="option"
                  aria-selected={model.key === selected?.key}
                  aria-posinset={index + 1}
                  aria-setsize={visible.length}
                  aria-disabled={!!busy || !!model.disabled}
                  aria-label={[
                    model.name,
                    model.provider,
                    model.detail,
                    model.favorite ? "Favorite" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  aria-current={model.current ? "true" : undefined}
                  title={[model.name, model.provider, model.detail].filter(Boolean).join(" · ")}
                  className="model-picker-option"
                  data-active={model.key === selected?.key || undefined}
                  onMouseMove={() => setHighlight(model.key)}
                  onClick={() => {
                    if (!busy && !model.disabled) onModel(model.key);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="m-0 flex">
                      <Name name={model.name} />
                    </p>
                    {model.detail && (
                      <p className="m-0 flex text-xs text-muted-foreground">
                        <Name name={model.detail} />
                      </p>
                    )}
                  </div>
                  {model.favorite && <span aria-hidden="true">★</span>}
                  {index < 9 && (
                    <span className="shrink-0 text-xs text-muted-foreground">Ctrl+{index + 1}</span>
                  )}
                </div>
              </div>
            )}
          />
          {nativeModel && (
            <div className="shrink-0 border-t border-border p-2">
              <label className="mb-1 block text-xs text-muted-foreground">Native model ID</label>
              <Input
                aria-label="Model override"
                value={nativeModel.value}
                placeholder={nativeModel.placeholder}
                disabled={busy}
                onChange={(event) => nativeModel.onChange(event.target.value)}
                onCompositionStart={guard.start}
                onCompositionEnd={guard.end}
                onKeyDown={(event) => {
                  guard.noteKey(event.key);
                  if (event.key === "Enter" && guard.isComposition(event)) {
                    guard.consume();
                    event.preventDefault();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!busy) nativeModel.onSubmit();
                  }
                }}
              />
              <p className="mt-1 mb-0 text-xs text-muted-foreground">
                Native ID overrides are not an access policy; the agent validates availability at
                launch.
              </p>
            </div>
          )}
        </div>
        <div className="model-picker-thinking" role="group" aria-label="Thinking levels">
          <p className="mt-0 mb-2 text-xs text-muted-foreground">Thinking</p>
          {(selected?.name ?? modelName) && (
            <p className="my-2 flex text-sm font-medium">
              <Name name={selected?.name ?? modelName ?? ""} />
            </p>
          )}
          {selectedLevels.length > 0 ? (
            <Toolbar.Root
              orientation="vertical"
              aria-label="Thinking"
              className="flex flex-col gap-1"
            >
              {selectedLevels.map((value, index) => (
                <Toolbar.Button
                  key={value}
                  ref={value === level || (!level && index === 0) ? thinkingRef : undefined}
                  render={
                    <Button
                      layout="navigation"
                      size="sm"
                      variant={canChangeLevel && value === level ? "secondary" : "ghost"}
                    />
                  }
                  aria-pressed={canChangeLevel && value === level}
                  disabled={busy || (canChangeLevel ? !onLevel : !canChooseCandidateLevel)}
                  onClick={() => {
                    if (canChangeLevel) onLevel?.(value);
                    else if (selected && canChooseCandidateLevel)
                      onModelLevel?.(selected.key, value);
                  }}
                >
                  <Name name={value} />
                </Toolbar.Button>
              ))}
            </Toolbar.Root>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">
              {canChangeLevel
                ? (unavailable ?? "This driver reports no thinking levels.")
                : "Thinking levels not reported for this model."}
            </p>
          )}
        </div>
      </div>
      {error && (
        <div className="border-t border-border p-2">
          <FormError>{error}</FormError>
        </div>
      )}
      {footer && <div className="shrink-0 border-t border-border px-3 py-2">{footer}</div>}
    </div>
  );
}
