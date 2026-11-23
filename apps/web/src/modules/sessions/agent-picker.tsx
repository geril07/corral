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
import { useRef, useState, type RefObject } from "react";
import { Button, ModelPickerButton, TaskDialog } from "../../common/ui/index.ts";
import { AgentLaunchPicker, LaunchViewControls } from "./agent-launch-picker.tsx";
import {
  defaultLaunch,
  launchChoice,
  launchKey,
  launchModelLabel,
  launchName,
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
  const [picking, setPicking] = useState(true);
  const [pickingReasoning, setPickingReasoning] = useState(false);
  const modelAnchor = useRef<HTMLButtonElement>(null);
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
    void onStart({
      ...launchChoice(target),
      ...(targetView === "chat" ? {} : { thinking: undefined, expectedModel: undefined }),
      view: targetView,
    })
      .catch((caught: unknown) => {
        if (launchErrorCode(caught) === "LAUNCH_PROFILE_CHANGED") setConflicted(launchKey(target));
        else setFailure(describeLaunchError(caught) ?? describeError(caught));
      })
      .finally(() => setBusy(false));
  };
  return (
    <TaskDialog
      title="Start agent session"
      onClose={onClose}
      finalFocus={() => anchor?.current ?? null}
      beforeClose={() => !busy}
    >
      <div className="flex flex-col gap-4">
        <ModelPickerButton
          ref={modelAnchor}
          kind={selection.kind}
          label={[launchName(selection), launchModelLabel(selection, effectiveView === "chat")]
            .filter(Boolean)
            .join(" · ")}
          aria-label={`Agent ${[launchName(selection), launchModelLabel(selection, effectiveView === "chat")].filter(Boolean).join(" · ")}`}
          onClick={() => {
            setPickingReasoning(false);
            setPicking(true);
          }}
          disabled={busy}
        />
        {effectiveView === "chat" && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={selection.thinking ? `Reasoning ${selection.thinking.level}` : "Reasoning"}
            disabled={busy || (selection.kind !== "pi" && selection.kind !== "codex")}
            onClick={() => {
              setPickingReasoning(true);
              setPicking(true);
            }}
          >
            {selection.thinking?.level ?? "Reasoning"}
          </Button>
        )}
        <LaunchViewControls
          value={effectiveView}
          kind={selection.kind}
          chatDrivers={chatDrivers}
          disabled={busy}
          onChange={(next) => {
            setView(next);
            if (next !== "chat")
              setSelection((current) => ({
                ...current,
                thinking: undefined,
                expectedModel: undefined,
              }));
          }}
        />
        {error && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          disabled={
            busy ||
            waiting ||
            launchProblem(selection, profiles, agents) !== undefined ||
            conflicted === launchKey(selection)
          }
          onClick={() => submit(selection)}
        >
          Start session
        </Button>
      </div>
      {picking && (
        <AgentLaunchPicker
          title="New agent session"
          context={context}
          anchor={modelAnchor}
          restoreFocus="anchor"
          profiles={profiles}
          agents={agents}
          selection={selection}
          thinkingEnabled={effectiveView === "chat"}
          focus={pickingReasoning ? "thinking" : "search"}
          defaultSelection={defaultLaunch(settings, profiles, agents)}
          onChange={(next, reason) => {
            setSelection(next);
            setFailure(undefined);
            if (reason === "instance") setConflicted(undefined);
          }}
          onCommit={(target) => {
            if (!launchProblem(target, profiles, agents) && conflicted !== launchKey(target))
              setPicking(false);
          }}
          onClose={() => setPicking(false)}
          error={error}
          blocked={
            !!launchProblem({ ...selection, model: "" }, profiles, agents) ||
            conflicted === launchKey(selection)
          }
          busy={busy || waiting}
        />
      )}
    </TaskDialog>
  );
}
