import type { AgentSettings, LaunchProfile, TaskView } from "@corral/protocol/config";
import type { AgentKind } from "@corral/protocol/rpc";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useCorralClient } from "../connection/index.ts";
import type { ModelContext } from "@corral/protocol/models";
import { modelKey } from "@corral/protocol/models";
import { useModelMenu } from "../settings/index.ts";
import {
  Button,
  ModelPicker,
  type PickerInstance,
  type PickerModel,
} from "../../common/ui/index.ts";
import {
  launchKey,
  launchScope,
  catalogLaunchModel,
  launchCatalogRow,
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
          onClick={() => onChange(view)}
        >
          {view === "chat" ? "Chat" : "Terminal"}
        </Button>
      ))}
    </div>
  );
}

export function launchPickerInstances(options: readonly LaunchSelection[]): PickerInstance[] {
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
  thinkingEnabled = false,
  focus = "search",
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
  thinkingEnabled?: boolean;
  focus?: "search" | "thinking";
}) {
  const client = useCorralClient();
  const [savingLevel, setSavingLevel] = useState(false);
  const [selectingModel, setSelectingModel] = useState(false);
  const [levelError, setLevelError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const options = launchOptions(profiles, agents);
  const key = launchKey(selection);
  const instances = launchPickerInstances(options);
  const menu = useModelMenu({
    scope: launchScope(selection),
    context: context ?? {},
    ...(selection.profile ? { expectedProfileRevision: selection.profile.revision } : {}),
  });
  // The configured default names this instance; another instance has no configured model of its
  // own, so its baseline is the native default.
  const configured =
    defaultSelection !== undefined && launchKey(defaultSelection) === key
      ? defaultSelection
      : undefined;
  const configuredRow =
    configured === undefined ? undefined : launchCatalogRow(configured, menu.all);
  // OpenCode has no model launch flag: a model chosen for its chat is carried on the session and
  // applied before the first prompt, so the picker offers catalog rows and remembers the ref
  // instead of a flag value.
  const chatCarriesModel = thinkingEnabled && selection.kind === "opencode";
  const expectedRef = chatCarriesModel ? selection.expectedModel : undefined;
  const modelSelectable = (model: (typeof menu.all)[number]): boolean =>
    chatCarriesModel ? model.provider !== null : catalogLaunchModel(selection, model) !== undefined;
  const currentRow =
    expectedRef === undefined
      ? chatCarriesModel
        ? undefined
        : launchCatalogRow(selection, menu.all)
      : menu.all.find(
          (model) => model.provider === expectedRef.provider && model.id === expectedRef.id,
        );
  const supportsThinking = selection.kind === "pi" || selection.kind === "codex";
  const currentMemory =
    thinkingEnabled && supportsThinking && menu.catalog?.status === "ready" && currentRow
      ? menu.catalog.rememberedThinking?.find(
          (entry) =>
            modelKey(entry.model) === modelKey(currentRow) &&
            currentRow.reasoningLevels?.includes(entry.level),
        )
      : undefined;
  const current = chatCarriesModel
    ? expectedRef !== undefined &&
      !menu.models.some(
        (model) => model.provider === expectedRef.provider && model.id === expectedRef.id,
      )
      ? {
          key: CURRENT_ROW_KEY,
          name: expectedRef.id,
          current: true,
          disabled: blocked,
          detail: "Current · hidden by filter",
        }
      : undefined
    : launchCurrentModelRow(selection, menu.all, menu.models.map(modelKey), blocked);
  const models: PickerModel[] = [
    // The synthetic row already names a configured default in its detail; one mark per row.
    ...(current ? [current] : []),
    ...menu.models.map((model) => ({
      key: modelKey(model),
      name: model.name,
      provider: model.provider ?? undefined,
      detail: modelSelectable(model) ? model.id : "Not selectable by this launch adapter/provider",
      disabled: blocked || !modelSelectable(model),
      favorite: menu.favorite(model),
      current: currentRow === undefined ? false : modelKey(currentRow) === modelKey(model),
      default: configuredRow !== undefined && modelKey(configuredRow) === modelKey(model),
    })),
  ];
  // Another instance means another runtime and model space: the previous model text is not
  // carried over, because doing so would switch the model silently.
  // Re-picking the instance already shown changes nothing, so its configured model stays.
  const select = (option: LaunchSelection) =>
    onChange(
      launchKey(option) === key
        ? {
            ...option,
            model: selection.model,
            thinking: selection.thinking,
            expectedModel: selection.expectedModel,
          }
        : { ...option, model: "" },
      "instance",
    );
  return (
    <ModelPicker
      focus={focus}
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
        if (reported === undefined) return;
        if (chatCarriesModel) {
          if (reported.provider === null) return;
          const target = {
            ...selection,
            model: "",
            expectedModel: { provider: reported.provider, id: reported.id },
            thinking: undefined,
          };
          onChange(target, "model");
          onCommit(target);
          return;
        }
        const value = catalogLaunchModel(selection, reported);
        if (value === undefined) return;
        const commit = (level: string | null) => {
          if (!mounted.current) return;
          const remembered =
            level !== null && reported.reasoningLevels?.includes(level)
              ? { model: { provider: reported.provider, id: reported.id }, level, remembered: true }
              : undefined;
          const target = {
            ...selection,
            model: value,
            expectedModel:
              selection.kind === "pi" || (selection.kind === "codex" && thinkingEnabled)
                ? { provider: reported.provider, id: reported.id }
                : undefined,
            thinking: remembered,
          };
          onChange(target, "model");
          onCommit(target);
        };
        if (!thinkingEnabled || !supportsThinking || menu.catalog?.status !== "ready") {
          commit(null);
          return;
        }
        setSelectingModel(true);
        void client.connection.api.models
          .thinking({ scope: launchScope(selection), model: reported })
          .then(commit, () => commit(null))
          .finally(() => {
            if (mounted.current) setSelectingModel(false);
          });
      }}
      levels={
        thinkingEnabled && supportsThinking && menu.catalog?.status === "ready"
          ? currentRow?.reasoningLevels
          : undefined
      }
      level={selection.thinking?.level ?? currentMemory?.level}
      onLevel={
        thinkingEnabled &&
        supportsThinking &&
        menu.catalog?.status === "ready" &&
        currentRow?.reasoningLevels !== undefined
          ? (level) => {
              if (savingLevel) return;
              setSavingLevel(true);
              setLevelError(undefined);
              const model = { provider: currentRow.provider, id: currentRow.id };
              void client.connection.api.models
                .rememberThinking({
                  scope: launchScope(selection),
                  context: context ?? {},
                  ...(selection.profile
                    ? { expectedProfileRevision: selection.profile.revision }
                    : {}),
                  model,
                  level,
                })
                .then(() => {
                  if (!mounted.current) return;
                  const target = {
                    ...selection,
                    thinking: { model, level, remembered: true },
                  };
                  onChange(target, "model");
                  onCommit(target);
                })
                .catch(() => {
                  if (mounted.current)
                    setLevelError("Could not confirm and save this thinking level.");
                })
                .finally(() => {
                  if (mounted.current) setSavingLevel(false);
                });
            }
          : undefined
      }
      error={levelError ?? error}
      busy={busy || savingLevel || selectingModel}
      loading={menu.pickerLoading}
      modelStatus={menu.pickerStatus}
      reasoningStatus={
        !thinkingEnabled || !supportsThinking
          ? "Reasoning cannot be selected before launch for this agent."
          : menu.catalog?.status !== "ready"
            ? "Reasoning levels have not been confirmed."
            : undefined
      }
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
