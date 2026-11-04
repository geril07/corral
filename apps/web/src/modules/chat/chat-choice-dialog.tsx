import type { ChatStore } from "@corral/client/chat-store";
import { describeError } from "@corral/client/rpc-errors";
import type { ChatModelRef } from "@corral/protocol/chat";
import type {
  AgentSettings,
  LaunchProfile,
  ResolvedTaskSettings,
  TaskView,
} from "@corral/protocol/config";
import type { AgentKind, LaunchSnapshot } from "@corral/protocol/rpc";
import { useState, useSyncExternalStore, type RefObject } from "react";
import { ModelPicker } from "../../common/ui/index.ts";
import {
  launchChoice,
  launchKey,
  launchModel,
  launchOptions,
  launchProblem,
  launchView,
  launchPickerInstances,
  launchPickerModels,
  supportsModel,
  LaunchViewControls,
  type AgentLaunchChoice,
  type LaunchSelection,
} from "../sessions/index.ts";
import { chatModelKey } from "./chat-choices.ts";

export interface ChatChoiceDialogProps {
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
  if (retained) {
    const active = instances.find((instance) => instance.key === currentKey);
    if (active) active.name += " (current session)";
  }
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
      const target = key === "default" ? { ...selection, model: "" } : selection;
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
      models={
        existing
          ? state.models.map((model) => ({
              key: chatModelKey(model),
              name: model.name,
              provider: model.provider ?? undefined,
              detail: model.id === model.name ? undefined : model.id,
              current: chatModelKey(model) === reported,
            }))
          : launchPickerModels(
              selection,
              !!launchProblem({ ...selection, model: "" }, profiles, agents),
            )
      }
      onModel={chooseModel}
      modelName={existing ? state.model?.name : launchModel(selection)}
      levels={existing && !waiting ? state.reasoningLevels : []}
      level={existing ? state.reasoning : undefined}
      onLevel={(level) => {
        if (existing && !waiting) void apply(() => onSetReasoning(level), true);
      }}
      unavailable={
        existing
          ? waiting
            ? "Waiting for the agent's updated model and thinking levels…"
            : "This driver reports no thinking levels."
          : "A different tool/profile starts a new session. Its thinking levels are reported after launch."
      }
      emptyMessage={
        snapshot.loaded
          ? "This driver offers no model switch. Choose another tool to start a session."
          : "Waiting for the agent's model list…"
      }
      nativeModel={
        !existing && supportsModel(selection.kind)
          ? {
              value: selection.model,
              placeholder: selection.profile?.model ?? "Agent default",
              onChange: (model) => setSelection({ ...selection, model }),
              onSubmit: () => chooseModel("custom"),
            }
          : undefined
      }
      error={problem ?? failure}
      busy={busy}
      footer={
        !existing ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">New agent session</span>
            <LaunchViewControls
              value={view}
              kind={selection.kind}
              chatDrivers={chatDrivers}
              onChange={setRequestedView}
              disabled={busy}
            />
          </div>
        ) : undefined
      }
      onClose={onClose}
    />
  );
}
