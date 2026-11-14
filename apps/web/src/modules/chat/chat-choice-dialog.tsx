import type { ChatStore } from "@corral/client/chat-store";
import { describeError } from "@corral/client/rpc-errors";
import type { ChatModelRef } from "@corral/protocol/chat";
import { modelKey, modelVisible, type ModelContext } from "@corral/protocol/models";
import { useModelMenu } from "../settings/index.ts";
import type {
  AgentSettings,
  LaunchProfile,
  ResolvedTaskSettings,
  TaskView,
} from "@corral/protocol/config";
import type { AgentKind, LaunchSnapshot } from "@corral/protocol/rpc";
import { useState, useSyncExternalStore, type RefObject } from "react";
import { ModelPicker, type PickerModel } from "../../common/ui/index.ts";
import {
  defaultLaunch,
  launchChoice,
  launchKey,
  launchScope,
  catalogLaunchModel,
  launchCatalogRow,
  launchModel,
  launchOptions,
  launchProblem,
  launchView,
  launchPickerInstances,
  launchCurrentModelRow,
  LaunchViewControls,
  type AgentLaunchChoice,
  type LaunchSelection,
} from "../sessions/index.ts";
import { chatModelKey } from "./chat-choices.ts";

export interface ChatChoiceDialogProps {
  context?: ModelContext | undefined;
  store: ChatStore;
  kind: "model" | "reasoning";
  agent: AgentKind;
  launch: LaunchSnapshot | null | undefined;
  profiles: readonly LaunchProfile[];
  agents: AgentSettings;
  settings: ResolvedTaskSettings;
  chatDrivers: readonly AgentKind[];
  anchor: RefObject<HTMLElement | null>;
  onSetModel: (model: ChatModelRef) => Promise<void>;
  onSetReasoning: (level: string) => Promise<void>;
  onStart: (choice: AgentLaunchChoice) => Promise<void>;
  onClose: () => void;
}

/** Existing-instance changes use its driver; another tool/profile starts a distinct session. */
export function ChatChoiceDialog({
  context,
  store,
  kind,
  agent,
  launch,
  profiles,
  agents,
  settings,
  chatDrivers,
  anchor,
  onSetModel,
  onSetReasoning,
  onStart,
  onClose,
}: ChatChoiceDialogProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const state = snapshot.state;
  const current: LaunchSelection = {
    kind: agent,
    model: launch?.model ?? "",
    profile: launch?.profile
      ? { ...launch.profile, model: launch.model, provider: launch.provider }
      : null,
  };
  const currentKey = launchKey(current);
  const [selection, setSelection] = useState(current);
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pendingModel, setPendingModel] = useState<string>();
  const [requestedView, setRequestedView] = useState<TaskView>();
  const existing = launchKey(selection) === currentKey;
  const reported = state.model ? chatModelKey(state.model) : undefined;
  if (pendingModel !== undefined && pendingModel === reported) setPendingModel(undefined);
  const waiting = pendingModel !== undefined && pendingModel !== reported;
  const options = launchOptions(profiles, agents);
  const retained = !options.some((option) => launchKey(option) === currentKey);
  if (retained) options.unshift(current);
  const instances = launchPickerInstances(options);
  const menu = useModelMenu(
    {
      scope: launchScope(selection),
      context: context ?? {},
      ...(selection.profile ? { expectedProfileRevision: selection.profile.revision } : {}),
    },
    existing && state.models.length > 0
      ? {
          scope: launchScope(current),
          context: context ?? {},
          profileRevision: current.profile?.revision,
          models: state.models,
        }
      : undefined,
  );
  const hidden =
    existing &&
    state.model &&
    menu.preferences.loaded &&
    !modelVisible(menu.preferences.policy, state.model);
  // The configured default names this instance; another instance has no default here to return to.
  const defaultSelection = defaultLaunch(settings, profiles, agents);
  const configured =
    defaultSelection !== undefined && launchKey(defaultSelection) === launchKey(selection)
      ? defaultSelection
      : undefined;
  const configuredModel = configured === undefined ? undefined : launchModel(configured);
  const configuredRow =
    configured === undefined ? undefined : launchCatalogRow(configured, menu.all);
  const currentModel = launchModel(selection);
  const currentRow = existing ? undefined : launchCatalogRow(selection, menu.all);
  const blocked = !!launchProblem({ ...selection, model: "" }, profiles, agents);
  const launchCurrent = launchCurrentModelRow(
    selection,
    menu.all,
    menu.models.map(modelKey),
    blocked,
  );
  const launchModels: PickerModel[] = [
    ...(launchCurrent
      ? [{ ...launchCurrent, default: launchCurrent.name === configuredModel }]
      : []),
    ...menu.models.map((model) => ({
      key: modelKey(model),
      name: model.name,
      provider: model.provider ?? undefined,
      detail: model.id,
      disabled: blocked || catalogLaunchModel(selection, model) === undefined,
      favorite: menu.favorite(model),
      current: currentRow === undefined ? false : modelKey(currentRow) === modelKey(model),
      default: configuredRow !== undefined && modelKey(configuredRow) === modelKey(model),
    })),
  ];
  const models: PickerModel[] = existing
    ? menu.models.map((model) => ({
        key: chatModelKey(model),
        name: model.name,
        provider: model.provider ?? undefined,
        detail: model.id === model.name ? undefined : model.id,
        current: chatModelKey(model) === reported,
        disabled: !state.models.some((m) => chatModelKey(m) === chatModelKey(model)),
        favorite: menu.favorite(model),
        default: configuredRow !== undefined && chatModelKey(configuredRow) === chatModelKey(model),
      }))
    : launchModels;
  if (hidden && state.model && !models.some((m) => m.current))
    models.unshift({
      key: chatModelKey(state.model),
      name: state.model.name,
      provider: state.model.provider ?? undefined,
      detail: "Current · hidden by filter",
      current: true,
      disabled: true,
      favorite: menu.favorite(state.model),
      default:
        configuredRow !== undefined && chatModelKey(configuredRow) === chatModelKey(state.model),
    });
  const problem = existing ? undefined : launchProblem(selection, profiles, agents);
  const view = launchView(
    { ...settings, view: { ...settings.view, value: requestedView ?? settings.view.value } },
    selection.kind,
    chatDrivers,
  );
  const apply = async (action: () => Promise<void>, close: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await action();
      if (close) onClose();
    } catch (error) {
      setPendingModel(undefined);
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  const chooseModel = (key: string) => {
    if (existing) {
      const model = state.models.find((candidate) => chatModelKey(candidate) === key);
      if (!model || key === reported) return;
      setPendingModel(key);
      void apply(() => onSetModel({ provider: model.provider, id: model.id }), false);
    } else {
      const row = menu.models.find((m) => modelKey(m) === key);
      const value = row ? catalogLaunchModel(selection, row) : undefined;
      const target = value ? { ...selection, model: value } : selection;
      if (launchProblem(target, profiles, agents)) return;
      void apply(() => onStart({ ...launchChoice(target), view }), true);
    }
  };
  return (
    <ModelPicker
      title={kind === "model" ? "Chat model" : "Reasoning level"}
      anchor={anchor}
      restoreFocus="composer"
      focus={kind === "model" ? "search" : "thinking"}
      instances={instances}
      instance={launchKey(selection)}
      onInstance={(key) => {
        const next = options.find((option) => launchKey(option) === key);
        if (next) {
          setSelection(next);
          setPendingModel(undefined);
          setFailure(undefined);
        }
      }}
      models={models}
      onModel={chooseModel}
      modelName={existing ? state.model?.name : currentModel}
      levels={existing && !waiting ? state.reasoningLevels : []}
      level={existing ? state.reasoning : undefined}
      onLevel={(level) => {
        if (existing && !waiting) void apply(() => onSetReasoning(level), false);
      }}
      levelsPending={existing && waiting}
      error={problem ?? failure}
      busy={busy}
      footer={
        !existing ? (
          <LaunchViewControls
            value={view}
            kind={selection.kind}
            chatDrivers={chatDrivers}
            onChange={setRequestedView}
            disabled={busy}
          />
        ) : undefined
      }
      onClose={onClose}
    />
  );
}
