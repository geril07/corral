import type { AgentSettings, LaunchProfile, TaskView } from "@corral/protocol/config";
import type { AgentKind } from "@corral/protocol/rpc";
import type { RefObject } from "react";
import type { ModelContext } from "@corral/protocol/models";
import { modelKey } from "@corral/protocol/models";
import { useModelMenu } from "../settings/index.ts";
import { Button, ModelPicker, type PickerModel } from "../../common/ui/index.ts";
import {
  launchKey,
  launchScope,
  catalogLaunchModel,
  launchCatalogRow,
  launchModel,
  launchName,
  launchOptions,
  modelOverride,
  launchCurrentModelRow,
  CURRENT_ROW_KEY,
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

/** The same launch selection for a new task and an additional agent; neither invents a catalog. */
export function AgentLaunchPicker({
  title,
  context,
  anchor,
  restoreFocus,
  profiles,
  agents,
  selection,
  defaultSelection,
  onChange,
  onCommit,
  onClose,
  error,
  busy,
  blocked,
  footer,
}: {
  title: string;
  context?: ModelContext | undefined;
  anchor?: RefObject<HTMLElement | null> | undefined;
  restoreFocus?: "anchor" | "dialog" | "composer" | undefined;
  profiles: readonly LaunchProfile[];
  agents: AgentSettings;
  selection: LaunchSelection;
  /** The launch the effective task settings name; a different model here is an override. */
  defaultSelection?: LaunchSelection | undefined;
  onChange: (selection: LaunchSelection, reason: "instance" | "model") => void;
  onCommit: (selection: LaunchSelection) => void;
  onClose: () => void;
  error?: string | undefined;
  busy?: boolean | undefined;
  blocked?: boolean | undefined;
  /** The new-launch view choice; a picker footer never carries status or management actions. */
  footer?: React.ReactNode;
}) {
  const options = launchOptions(profiles, agents);
  const key = launchKey(selection);
  const instances = launchPickerInstances(options);
  const menu = useModelMenu({
    scope: launchScope(selection),
    context: context ?? {},
    ...(selection.profile ? { expectedProfileRevision: selection.profile.revision } : {}),
  });
  const currentModel = launchModel(selection);
  // The configured default names this instance; another instance has no configured model of its
  // own, so its baseline is the native default (`docs/layout.md`).
  const configured =
    defaultSelection !== undefined && launchKey(defaultSelection) === key
      ? defaultSelection
      : undefined;
  const configuredModel = configured === undefined ? undefined : launchModel(configured);
  const configuredRow =
    configured === undefined ? undefined : launchCatalogRow(configured, menu.all);
  const currentRow = launchCatalogRow(selection, menu.all);
  const current = launchCurrentModelRow(selection, menu.all, menu.models.map(modelKey), blocked);
  const models: PickerModel[] = [
    ...(current ? [{ ...current, default: current.name === configuredModel }] : []),
    ...menu.models.map((model) => ({
      key: modelKey(model),
      name: model.name,
      provider: model.provider ?? undefined,
      detail:
        catalogLaunchModel(selection, model) === undefined
          ? "Not selectable by this launch adapter/provider"
          : model.id,
      disabled: blocked || catalogLaunchModel(selection, model) === undefined,
      favorite: menu.favorite(model),
      current: currentRow === undefined ? false : modelKey(currentRow) === modelKey(model),
      default: configuredRow !== undefined && modelKey(configuredRow) === modelKey(model),
    })),
  ];
  // Another instance means another runtime and model space: the previous model text is not
  // carried over, because doing so would switch the model silently (`docs/layout.md`).
  // Re-picking the instance already shown changes nothing, so its configured model stays.
  const select = (option: LaunchSelection) =>
    onChange(
      launchKey(option) === key ? { ...option, model: selection.model } : { ...option, model: "" },
      "instance",
    );
  return (
    <ModelPicker
      focus="search"
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
        if (model === CURRENT_ROW_KEY) {
          onCommit(selection);
          return;
        }
        const reported = menu.models.find((m) => modelKey(m) === model);
        const value = reported ? catalogLaunchModel(selection, reported) : undefined;
        const target = value ? { ...selection, model: value } : selection;
        onChange(target, "model");
        onCommit(target);
      }}
      modelName={currentModel}
      error={error}
      busy={busy}
      footer={footer}
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
