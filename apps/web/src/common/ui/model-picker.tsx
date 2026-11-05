import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { Toolbar } from "@base-ui/react/toolbar";
import { useEnterGuard } from "../hooks/use-enter-guard.ts";
import { useRef, useState, type RefObject } from "react";
import type { AgentKind } from "@corral/protocol/rpc";
import { AgentIcon } from "./agent-icon.tsx";
import { Button } from "./button.tsx";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./command.tsx";
import { Input } from "./input.tsx";
import { Icon } from "./icon.tsx";
import { RadioGroup } from "./radio-group.tsx";
import { FormError, TaskDialog, useTaskFinalFocus } from "./task-dialog.tsx";
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
  suspended?: boolean | undefined;
  onClose: () => void;
}

/** Base UI owns collision handling, dismissal and focus; no popup coordinates are managed by modules. */
export function ModelPicker({ title, anchor, onClose, ...props }: ModelPickerProps) {
  const search = useRef<HTMLInputElement>(null);
  const instance = useRef<HTMLButtonElement>(null);
  const thinking = useRef<HTMLButtonElement>(null);
  const finalFocus = useTaskFinalFocus(props.restoreFocus === "composer");
  const [query, setQuery] = useState("");
  if (props.suspended) return null;
  const content = (
    <PickerContent
      {...props}
      title={title}
      anchor={anchor}
      onClose={onClose}
      searchRef={search}
      instanceRef={instance}
      thinkingRef={thinking}
      query={query}
      onQuery={setQuery}
    />
  );
  if (anchor === undefined)
    return (
      <TaskDialog title={title} layout="picker" onClose={onClose}>
        {content}
      </TaskDialog>
    );
  return (
    <Popover.Root
      open
      modal
      onOpenChange={(open) => {
        if (!open && !props.busy) onClose();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 outline-none"
        >
          <Popover.Popup
            aria-label={title}
            initialFocus={
              props.focus === "search" ? search : props.focus === "thinking" ? thinking : instance
            }
            finalFocus={props.restoreFocus === "anchor" ? anchor : finalFocus}
            className="flex max-h-(--available-height) w-[36rem] max-w-(--available-width) flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-floating outline-none"
          >
            <Popover.Close className="sr-only">Close picker</Popover.Close>
            {content}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
  instanceRef: RefObject<HTMLButtonElement | null>;
  thinkingRef: RefObject<HTMLButtonElement | null>;
}) {
  const guard = useEnterGuard();
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = models.filter((model) => {
    const text = `${model.name} ${model.provider ?? ""} ${model.detail ?? ""}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  return (
    <div
      className="flex min-h-0 flex-col"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          (event.ctrlKey || event.metaKey) &&
          /^[1-9]$/.test(event.key)
        ) {
          const model = models[Number(event.key) - 1];
          if (model && visible.includes(model) && !model.disabled && !busy) {
            event.preventDefault();
            onModel(model.key);
          }
        }
      }}
    >
      <div className="grid h-80 min-h-0 grid-cols-[3rem_minmax(0,1fr)_11rem]">
        <RadioGroup
          aria-label="agent"
          value={instance}
          onValueChange={(key) => {
            if (!busy) onInstance(String(key));
          }}
          className="flex w-auto flex-col gap-1 overflow-y-auto border-r border-border p-1"
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              event.shiftKey
            )
              return;
            if (event.key === "Enter" && onInstanceEnter) {
              event.preventDefault();
              onInstanceEnter();
            }
            if (/^[1-9]$/.test(event.key) && onQuickChoice) {
              event.preventDefault();
              onQuickChoice(Number(event.key) - 1);
            }
          }}
        >
          {instances.map((item) => (
            <Radio.Root
              key={item.key}
              title={[item.name, item.detail].filter(Boolean).join(" · ")}
              ref={item.key === instance ? instanceRef : undefined}
              value={item.key}
              aria-label={item.name}
              disabled={busy}
              className="relative flex size-9 shrink-0 items-center justify-center rounded-(--control-radius) border border-transparent text-muted-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring data-checked:border-border data-checked:bg-accent data-checked:text-foreground"
            >
              <AgentIcon kind={item.kind} size="chrome" />
              {item.badge && (
                <span className="absolute right-0 bottom-0 rounded-sm bg-muted px-0.5 text-xs text-foreground">
                  {item.badge}
                </span>
              )}
            </Radio.Root>
          ))}
        </RadioGroup>
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <p className="m-0 flex shrink-0 px-2 pt-2 text-xs font-medium">
            <Name name={instances.find((item) => item.key === instance)?.name ?? ""} />
          </p>
          <Command label="Models" shouldFilter={false}>
            <CommandInput
              ref={searchRef}
              aria-label="Search models"
              placeholder="Search models…"
              value={query}
              onValueChange={onQuery}
            />
            <CommandList className="min-h-0 max-h-none flex-1">
              {visible.length === 0 && (
                <CommandEmpty>
                  {query ? "No models match." : (emptyMessage ?? "No models reported.")}
                </CommandEmpty>
              )}
              {visible.map((model) => (
                <CommandItem
                  key={model.key}
                  value={model.key}
                  disabled={!!busy || !!model.disabled}
                  data-checked={model.current}
                  aria-current={model.current ? "true" : undefined}
                  onSelect={() => onModel(model.key)}
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
                  {model.favorite && <span aria-label="Favorite">★</span>}
                  {model.provider && (
                    <span className="flex max-w-1/3 text-xs text-muted-foreground">
                      <Name name={model.provider} />
                    </span>
                  )}
                  {models.indexOf(model) < 9 && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Ctrl+{models.indexOf(model) + 1}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
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
                  if (event.key === "Enter" && guard.isComposition(event)) {
                    guard.consume();
                    event.preventDefault();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    nativeModel.onSubmit();
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
        <div
          className="min-w-0 overflow-y-auto border-l border-border p-2"
          role="group"
          aria-label="Thinking levels"
        >
          <p className="mt-0 mb-2 text-xs text-muted-foreground">Thinking</p>
          {modelName && (
            <p className="my-2 flex text-sm font-medium">
              <Name name={modelName} />
            </p>
          )}
          {levels.length > 0 ? (
            <Toolbar.Root
              orientation="vertical"
              aria-label="Thinking"
              className="flex flex-col gap-1"
            >
              {levels.map((value, index) => (
                <Toolbar.Button
                  key={value}
                  ref={value === level || (!level && index === 0) ? thinkingRef : undefined}
                  render={
                    <Button
                      layout="navigation"
                      size="sm"
                      variant={value === level ? "secondary" : "ghost"}
                    />
                  }
                  aria-pressed={value === level}
                  disabled={busy || !onLevel}
                  onClick={() => onLevel?.(value)}
                >
                  <Name name={value} />
                </Toolbar.Button>
              ))}
            </Toolbar.Root>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">
              {unavailable ?? "This driver reports no thinking levels."}
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
