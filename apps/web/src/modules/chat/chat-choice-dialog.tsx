import type { ChatStore } from "@corral/client/chat-store";
import { describeError } from "@corral/client/rpc-errors";
import type { ChatModelRef } from "@corral/protocol/chat";
import { modelKey, modelVisible, orderModels } from "@corral/protocol/models";
import { useModelPreferences } from "../settings/index.ts";
import type { AgentSettings, LaunchProfile } from "@corral/protocol/config";
import type { AgentKind, LaunchSnapshot } from "@corral/protocol/rpc";
import { useState, useSyncExternalStore, type RefObject } from "react";
import { ModelPicker, type PickerModel } from "../../common/ui/index.ts";
import {
  launchKey,
  launchOptions,
  launchPickerInstances,
  launchScope,
  type LaunchSelection,
} from "../sessions/index.ts";
import { chatModelKey } from "./chat-choices.ts";

/** A running chat keeps the agent that owns its native conversation; another one is a new chat. */
const AGENT_SWITCH_HINT = "Switching agents in a running chat is not supported yet.";

export interface ChatChoiceDialogProps {
  store: ChatStore;
  kind: "model" | "reasoning";
  agent: AgentKind;
  launch: LaunchSnapshot | null | undefined;
  profiles: readonly LaunchProfile[];
  agents: AgentSettings;
  /** Whether the running driver supports changing reasoning. */
  levelsSupported: boolean;
  modelSwitchSupported?: boolean | undefined;
  anchor: RefObject<HTMLElement | null>;
  onSetModel: (model: ChatModelRef, level?: string) => Promise<void>;
  onSetReasoning: (level: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Changes the model and reasoning level of the running chat itself. It never launches: starting
 * another chat belongs to the task's own agent actions, so every other agent is refused here.
 */
export function ChatChoiceDialog({
  store,
  kind,
  agent,
  launch,
  profiles,
  agents,
  levelsSupported,
  modelSwitchSupported = true,
  anchor,
  onSetModel,
  onSetReasoning,
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
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The chooser marks the next turn's choice, which is what a click here changes; the running
  // model stays visible on the answers that used it.
  const selection = state.selection ?? null;
  const chosen = selection?.model ?? state.model;
  const reported = chosen ? chatModelKey(chosen) : undefined;
  const chosenEntry =
    reported === undefined
      ? undefined
      : state.models.find((model) => chatModelKey(model) === reported);
  const preferences = useModelPreferences(launchScope(current));
  const favorite = (model: { provider: string | null; id: string }) =>
    preferences.policy.favorites.some((entry) => modelKey(entry) === modelKey(model));
  const options = launchOptions(profiles, agents);
  // A profile this build no longer lists still names the running chat's own agent.
  if (!options.some((option) => launchKey(option) === currentKey)) options.unshift(current);
  const instances = launchPickerInstances(options).map((item) =>
    item.key === currentKey
      ? item
      : {
          key: item.key,
          kind: item.kind,
          name: item.name,
          detail: item.detail,
          badge: item.badge,
          disabled: true,
          hint: AGENT_SWITCH_HINT,
        },
  );
  // The driver's own list is what this chat can run; the catalog only supplies order and favorites.
  const policy = preferences.policy;
  const shown = orderModels(
    policy,
    state.models.filter((model) => modelVisible(policy, model)),
  );
  const models: PickerModel[] = shown.map((model) => ({
    key: chatModelKey(model),
    name: model.name,
    provider: model.provider ?? undefined,
    detail: model.id === model.name ? undefined : model.id,
    current: chatModelKey(model) === reported,
    disabled: !modelSwitchSupported,
    favorite: favorite(model),
    levels: levelsSupported ? model.reasoningLevels : undefined,
  }));
  // A policy that hides the chosen model must not hide that the chat is on it.
  const chosenName =
    chosenEntry?.name ??
    (chosen !== null && state.model !== null && chatModelKey(chosen) === chatModelKey(state.model)
      ? state.model.name
      : chosen?.id);
  if (
    chosen &&
    !shown.some((model) => chatModelKey(model) === chatModelKey(chosen)) &&
    reported !== undefined
  )
    models.unshift({
      key: reported,
      name: chosenName ?? reported,
      provider: chosen.provider ?? undefined,
      detail: "Current · hidden by filter",
      current: true,
      disabled: true,
      favorite: favorite(chosen),
      levels: levelsSupported ? chosenEntry?.reasoningLevels : undefined,
    });
  // The levels are the selected model's, not the running one's: a queued or next-turn model may be
  // different, and offering the other model's levels would be a choice it cannot take.
  const levels =
    chosenEntry?.reasoningLevels ??
    (reported !== undefined && state.model !== null && reported === chatModelKey(state.model)
      ? state.reasoningLevels
      : []);
  // A level the live driver has not confirmed is stored, but it is not the choice a turn would
  // run on; marking it as selected here would claim it was applied.
  const selectionIssue = state.selectionIssue ?? null;
  const selectedLevel =
    selectionIssue !== null
      ? undefined
      : selection === null
        ? state.reasoning
        : (selection.level ??
          (reported !== undefined && state.model !== null && reported === chatModelKey(state.model)
            ? state.reasoning
            : null));
  const apply = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await action();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  const chooseModel = (key: string) => {
    const model = state.models.find((candidate) => chatModelKey(candidate) === key);
    if (!model || key === reported) return;
    void apply(() => onSetModel({ provider: model.provider, id: model.id }));
  };
  return (
    <ModelPicker
      title={kind === "model" ? "Chat model" : "Reasoning level"}
      anchor={anchor}
      restoreFocus="composer"
      focus={kind === "model" ? "search" : "thinking"}
      instances={instances}
      instance={currentKey}
      onInstance={() => undefined}
      models={models}
      onModel={chooseModel}
      levels={levels}
      level={selectedLevel}
      onLevel={levelsSupported ? (level) => void apply(() => onSetReasoning(level)) : undefined}
      onModelLevel={
        levelsSupported && modelSwitchSupported
          ? (key, level) => {
              const model = state.models.find((candidate) => chatModelKey(candidate) === key);
              if (model)
                void apply(() => onSetModel({ provider: model.provider, id: model.id }, level));
            }
          : undefined
      }
      levelsPending={state.reasoningStatus === "loading"}
      reasoningStatus={
        !levelsSupported
          ? "This agent does not support changing reasoning."
          : selectionIssue !== null
            ? selectionIssue.reason === "unavailable"
              ? "The selected thinking level is no longer available. Choose another level."
              : "The selected thinking level could not be confirmed. Choose another level."
            : state.reasoningStatus === "error"
              ? "Could not load reasoning levels."
              : undefined
      }
      error={failure}
      busy={busy || state.modelSelectionPending === true}
      onClose={onClose}
    />
  );
}
