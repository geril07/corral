import { describeError } from "@corral/client/rpc-errors";
import { profileChanged } from "@corral/client/launch-messages";
import type {
  AgentSettings,
  LaunchProfile,
  ResolvedTaskSettings,
  TaskView,
} from "@corral/protocol/config";
import type { ModelContext } from "@corral/protocol/models";
import type { AgentKind } from "@corral/protocol/rpc";
import { useState, type RefObject } from "react";
import { AgentLaunchPicker, LaunchViewControls } from "./agent-launch-picker.tsx";
import {
  defaultLaunch,
  launchChoice,
  launchKey,
  launchProblem,
  launchView,
  type AgentLaunchChoice,
  type LaunchSelection,
} from "./launch-choice.ts";
import { describeLaunchError, launchErrorCode } from "./launch-error.ts";

interface AgentPickerProps {
  context?: ModelContext | undefined;
  profiles: readonly LaunchProfile[];
  agents: AgentSettings;
  settings: ResolvedTaskSettings;
  chatDrivers: readonly AgentKind[];
  capabilitiesReady: boolean;
  anchor?: RefObject<HTMLElement | null> | undefined;
  onStart: (choice: AgentLaunchChoice) => Promise<void>;
  onClose: () => void;
}

export function AgentPicker({
  context,
  profiles,
  agents,
  settings,
  chatDrivers,
  capabilitiesReady,
  anchor,
  onStart,
  onClose,
}: AgentPickerProps) {
  const [selection, setSelection] = useState<LaunchSelection>(
    () => defaultLaunch(settings, profiles, agents) ?? { kind: "claude", profile: null, model: "" },
  );
  const [view, setView] = useState<TaskView>();
  const [failure, setFailure] = useState<string>();
  const [conflicted, setConflicted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const wanted = view ?? settings.view.value;
  const waiting = wanted === "chat" && !capabilitiesReady;
  const effectiveView =
    wanted === "chat"
      ? launchView(
          { ...settings, view: { ...settings.view, value: wanted } },
          selection.kind,
          chatDrivers,
        )
      : "terminal";
  const error =
    launchProblem(selection, profiles, agents) ??
    (conflicted === launchKey(selection) ? profileChanged(selection.profile?.name ?? "") : failure);
  const submit = (target: LaunchSelection) => {
    if (
      busy ||
      waiting ||
      launchProblem(target, profiles, agents) ||
      conflicted === launchKey(target)
    )
      return;
    setFailure(undefined);
    setBusy(true);
    const targetView = launchView(
      { ...settings, view: { ...settings.view, value: view ?? settings.view.value } },
      target.kind,
      chatDrivers,
    );
    void onStart({ ...launchChoice(target), view: targetView })
      .catch((caught: unknown) => {
        if (launchErrorCode(caught) === "LAUNCH_PROFILE_CHANGED") setConflicted(launchKey(target));
        else setFailure(describeLaunchError(caught) ?? describeError(caught));
      })
      .finally(() => setBusy(false));
  };
  return (
    <AgentLaunchPicker
      title="New agent session"
      context={context}
      anchor={anchor}
      profiles={profiles}
      agents={agents}
      selection={selection}
      defaultSelection={defaultLaunch(settings, profiles, agents)}
      onChange={(next, reason) => {
        setSelection(next);
        setFailure(undefined);
        if (reason === "instance") setConflicted(undefined);
      }}
      onCommit={submit}
      onClose={() => {
        if (!busy) onClose();
      }}
      error={error}
      blocked={
        !!launchProblem({ ...selection, model: "" }, profiles, agents) ||
        conflicted === launchKey(selection)
      }
      busy={busy || waiting}
      footer={
        <LaunchViewControls
          value={effectiveView}
          kind={selection.kind}
          chatDrivers={chatDrivers}
          disabled={busy}
          onChange={setView}
        />
      }
    />
  );
}
