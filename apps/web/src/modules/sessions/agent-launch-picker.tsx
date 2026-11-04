import type { AgentSettings, LaunchProfile, TaskView } from "@corral/protocol/config";
import type { AgentKind } from "@corral/protocol/rpc";
import type { RefObject } from "react";
import { Button, ModelPicker, type PickerModel } from "../../common/ui/index.ts";
import {
  launchKey,
  launchModel,
  launchName,
  launchOptions,
  modelOverride,
  modelProblem,
  supportsModel,
  type LaunchSelection,
} from "./launch-choice.ts";

export function LaunchViewControls({
  value,
  kind,
  chatDrivers,
  onChange,
  disabled,
}: {
  value: TaskView;
  kind: AgentKind | undefined;
  chatDrivers: readonly AgentKind[];
  onChange: (view: TaskView) => void;
  disabled?: boolean | undefined;
}) {
  const chat = kind !== undefined && chatDrivers.includes(kind);
  return (
    <div role="group" aria-label="Launch view" className="flex items-center gap-1">
      {(["chat", "terminal"] as const).map((view) => (
        <Button
          key={view}
          size="sm"
          variant={value === view ? "secondary" : "ghost"}
          aria-label={`Open in ${view}`}
          aria-pressed={value === view}
          disabled={disabled || (view === "chat" && !chat)}
          title={
            view === "chat" && !chat ? "This agent has no chat driver in this build." : undefined
          }
          onClick={() => onChange(view)}
        >
          {view === "chat" ? "Chat" : "Terminal"}
        </Button>
      ))}
    </div>
  );
}

export function launchPickerInstances(options: readonly LaunchSelection[]) {
  return options.map((option) => ({
    key: launchKey(option),
    kind: option.kind,
    name: launchName(option),
    ...(option.profile
      ? {
          badge: option.profile.name
            .split(/[\s_-]+/)
            .map((word) => word[0] ?? "")
            .join("")
            .slice(0, 2)
            .toUpperCase(),
          detail: option.profile.provider ?? option.profile.model ?? "Configured profile",
        }
      : { detail: "Native defaults" }),
  }));
}

export function launchPickerModels(selection: LaunchSelection, blocked = false): PickerModel[] {
  const overridden = supportsModel(selection.kind) ? modelOverride(selection.model) : undefined;
  const models: PickerModel[] = [
    {
      key: "default",
      name: selection.profile?.model ?? "Agent default",
      provider: selection.profile?.provider ?? undefined,
      current: overridden === undefined,
      disabled: blocked,
      detail: supportsModel(selection.kind) ? "Configured default" : "env only",
    },
  ];
  if (overridden)
    models.push({
      key: "custom",
      name: overridden,
      current: true,
      disabled: blocked || modelProblem(selection.kind, selection.model) !== undefined,
    });
  return models;
}

/** The same launch selection for a new task and an additional agent; neither invents a catalog. */
export function AgentLaunchPicker({
  title,
  anchor,
  restoreFocus,
  profiles,
  agents,
  selection,
  onChange,
  onCommit,
  onClose,
  error,
  busy,
  blocked,
  footer,
}: {
  title: string;
  anchor?: RefObject<HTMLElement | null> | undefined;
  restoreFocus?: "anchor" | "dialog" | "composer" | undefined;
  profiles: readonly LaunchProfile[];
  agents: AgentSettings;
  selection: LaunchSelection;
  onChange: (selection: LaunchSelection, reason: "instance" | "model") => void;
  onCommit: (selection: LaunchSelection) => void;
  onClose: () => void;
  error?: string | undefined;
  busy?: boolean | undefined;
  blocked?: boolean | undefined;
  footer?: React.ReactNode;
}) {
  const options = launchOptions(profiles, agents);
  const key = launchKey(selection);
  const instances = launchPickerInstances(options);
  const models = launchPickerModels(selection, blocked);
  const select = (option: LaunchSelection) =>
    onChange({ ...option, model: selection.model }, "instance");
  return (
    <ModelPicker
      title={title}
      anchor={anchor}
      restoreFocus={restoreFocus}
      instances={instances}
      instance={key}
      onInstance={(next) => {
        const option = options.find((candidate) => launchKey(candidate) === next);
        if (option) select(option);
      }}
      models={models}
      onModel={(model) => {
        const target = model === "default" ? { ...selection, model: "" } : selection;
        onChange(target, "model");
        onCommit(target);
      }}
      modelName={launchModel(selection)}
      unavailable="Thinking levels are reported by a running chat. Pre-launch thinking is not available yet."
      error={error}
      busy={busy}
      footer={footer}
      nativeModel={
        supportsModel(selection.kind)
          ? {
              value: selection.model,
              placeholder: selection.profile?.model ?? "Agent default",
              onChange: (model) => onChange({ ...selection, model }, "model"),
              onSubmit: () => onCommit(selection),
            }
          : undefined
      }
      onInstanceEnter={() => onCommit(selection)}
      onQuickChoice={(index) => {
        if (selection.profile || modelOverride(selection.model)) return;
        const native = options.filter((option) => option.profile === null)[index];
        if (native) {
          onChange(native, "instance");
          onCommit(native);
        }
      }}
      onClose={onClose}
    />
  );
}
