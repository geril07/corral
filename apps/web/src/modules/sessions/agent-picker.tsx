import { describeError } from "@corral/client/rpc-errors";
import { AGENTS } from "@corral/client/session-state";
import type { LaunchProfile } from "@corral/protocol/config";
import type { AgentKind } from "@corral/protocol/rpc";
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  Field,
  FormError,
  Input,
  Kbd,
  RadioGroup,
  RadioGroupItem,
} from "../../common/ui/index.ts";
import {
  modelOverride,
  modelProblem,
  supportsModel,
  type AgentLaunchChoice,
} from "./launch-choice.ts";
import { describeLaunchError } from "./launch-error.ts";

interface AgentPickerProps {
  /** The valid profiles of the config file, in file order. */
  profiles: readonly LaunchProfile[];
  /** Starts the chosen launch; rejects when the server refuses it, so the draft stays. */
  onStart: (choice: AgentLaunchChoice) => Promise<void>;
  onClose: () => void;
}

interface Choice {
  key: string;
  kind: AgentKind;
  native: boolean;
  profile?: LaunchProfile;
}

/**
 * What the user selected, pinned at selection time. A profile keeps its id and revision so a
 * live config change cannot silently turn it into a native launch with no profile.
 */
type Selection =
  | { kind: "native"; agent: AgentKind }
  | {
      kind: "profile";
      id: string;
      revision: string;
      name: string;
      agent: AgentKind;
      model: string | null;
      provider: string | null;
    };

const AGENT_ROW =
  "flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-active has-data-checked:bg-surface-active";

function choiceKey(selection: Selection): string {
  return selection.kind === "native"
    ? `native:${selection.agent}`
    : `profile:${selection.id}:${selection.revision}`;
}

function choicesOf(profiles: readonly LaunchProfile[]): Choice[] {
  return [
    ...AGENTS.map((kind): Choice => ({ key: `native:${kind}`, kind, native: true })),
    ...profiles.map((profile): Choice => ({
      key: `profile:${profile.id}:${profile.revision}`,
      kind: profile.agent,
      native: false,
      profile,
    })),
  ];
}

function selectionOfChoice(choice: Choice): Selection {
  const { profile } = choice;
  if (profile === undefined) return { kind: "native", agent: choice.kind };
  return {
    kind: "profile",
    id: profile.id,
    revision: profile.revision,
    name: profile.name,
    agent: profile.agent,
    model: profile.model,
    provider: profile.provider,
  };
}

/** Why the selected profile can no longer be launched, or `undefined` when it still applies. */
function staleSelectionReason(
  selection: Selection,
  profiles: readonly LaunchProfile[],
): string | undefined {
  if (selection.kind === "native") return undefined;
  const current = profiles.find((profile) => profile.id === selection.id);
  if (current === undefined) {
    return `The profile "${selection.name}" is no longer in the config file. Choose an agent or another profile.`;
  }
  if (current.revision !== selection.revision) {
    return `The profile "${current.name}" changed in the config file. Review it and choose it again.`;
  }
  return undefined;
}

/** A digit must not act while the user is typing or using a menu outside the radio list. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(
      "input, textarea, select, [contenteditable='true'], [role='combobox'], [role='menu'], [role='listbox']",
    ) !== null
  );
}

/** What the profile leaves the model at; OpenCode has no model flag at all. */
function profileModelText(agent: AgentKind, model: string | null): string {
  if (model !== null) return model;
  return supportsModel(agent) ? "agent default model" : "env only";
}

/** A native agent or a named profile, plus an optional native model override where supported. */
export function AgentPicker({ profiles, onStart, onClose }: AgentPickerProps) {
  const choices = choicesOf(profiles);
  const [selection, setSelection] = useState<Selection>(() => ({
    kind: "native",
    agent: AGENTS[0] ?? "claude",
  }));
  const [model, setModel] = useState("");
  const [failure, setFailure] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const stale = staleSelectionReason(selection, profiles);
  const currentProfile =
    selection.kind === "profile"
      ? profiles.find(
          (profile) => profile.id === selection.id && profile.revision === selection.revision,
        )
      : undefined;
  const kind =
    selection.kind === "native" ? selection.agent : (currentProfile?.agent ?? selection.agent);
  const offeredModel = supportsModel(kind);
  const typedModel = offeredModel ? modelOverride(model) : undefined;
  const effectiveModel =
    typedModel ??
    currentProfile?.model ??
    (selection.kind === "profile" ? selection.model : null) ??
    (offeredModel ? "agent default model" : "env only");
  const profileName =
    selection.kind === "profile" ? (currentProfile?.name ?? selection.name) : undefined;
  const profileProvider =
    selection.kind === "profile" ? (currentProfile?.provider ?? selection.provider) : undefined;

  const error = stale ?? failure;

  const submit = (target: Selection = selection, includeModel = true) => {
    if (submitting || staleSelectionReason(target, profiles) !== undefined) return;
    const targetProfile =
      target.kind === "profile"
        ? profiles.find(
            (profile) => profile.id === target.id && profile.revision === target.revision,
          )
        : undefined;
    if (target.kind === "profile" && targetProfile === undefined) return;
    const targetKind =
      target.kind === "native" ? target.agent : (targetProfile?.agent ?? target.agent);
    const invalid = includeModel ? modelProblem(targetKind, model) : undefined;
    if (invalid !== undefined) {
      setFailure(invalid);
      return;
    }
    const pickedModel =
      includeModel && supportsModel(targetKind) ? modelOverride(model) : undefined;
    setFailure(undefined);
    setSubmitting(true);
    void onStart({
      kind: targetKind,
      ...(targetProfile === undefined ? {} : { profileId: targetProfile.id }),
      ...(pickedModel === undefined ? {} : { model: pickedModel }),
    })
      .catch((caught: unknown) => {
        setFailure(describeLaunchError(caught) ?? describeError(caught));
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog title="New agent session" onClose={onClose}>
      {error && <FormError>{error}</FormError>}
      <RadioGroup
        className="mb-1"
        aria-label="agent"
        value={choiceKey(selection)}
        onValueChange={(key) => {
          const picked = choices.find((candidate) => candidate.key === key);
          if (picked === undefined) return;
          setSelection(selectionOfChoice(picked));
          setFailure(undefined);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "Enter") {
            if (event.shiftKey) return;
            event.preventDefault();
            submit();
            return;
          }
          if (!/^[1-9]$/.test(event.key) || event.shiftKey) return;
          if (isTextEntryTarget(event.target)) return;
          // A digit is a quick native choice only: it never discards a profile or a typed model.
          if (selection.kind !== "native" || modelOverride(model) !== undefined) return;
          const picked = AGENTS[Number(event.key) - 1];
          if (picked === undefined) return;
          event.preventDefault();
          submit({ kind: "native", agent: picked }, false);
        }}
      >
        {choices.map((candidate, index) => (
          <label key={candidate.key} className={AGENT_ROW}>
            <RadioGroupItem
              value={candidate.key}
              aria-label={candidate.native ? candidate.kind : candidate.profile?.name}
            />
            {candidate.native ? (
              <>
                <Kbd aria-hidden>{index + 1}</Kbd>
                {candidate.kind}
                <span className="text-text-muted">native default</span>
              </>
            ) : (
              <>
                <span className="min-w-0 truncate">{candidate.profile?.name}</span>
                <span className="text-text-muted">{candidate.kind}</span>
                <span className="min-w-0 truncate text-text-muted">
                  {profileModelText(candidate.kind, candidate.profile?.model ?? null)}
                </span>
                {candidate.profile?.provider && (
                  <span className="text-text-muted">provider {candidate.profile.provider}</span>
                )}
              </>
            )}
          </label>
        ))}
      </RadioGroup>
      {offeredModel && (
        <Field label="Model override (optional)">
          <Input
            aria-label="Model override"
            value={model}
            placeholder={
              currentProfile?.model ??
              (selection.kind === "profile" ? selection.model : null) ??
              "agent default"
            }
            onChange={(event) => {
              setModel(event.target.value);
              setFailure(undefined);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return;
              event.preventDefault();
              submit();
            }}
          />
        </Field>
      )}
      <p className="mb-2 text-text-muted" aria-label="launch choice">
        {selection.kind === "native"
          ? typedModel === undefined
            ? `${kind} with the agent's native defaults.`
            : `${kind} with model ${typedModel}.`
          : `${profileName}: ${kind}, ${effectiveModel}${
              profileProvider ? `, provider ${profileProvider}` : ""
            }.`}
      </p>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={submitting || stale !== undefined}
          onClick={() => submit()}
        >
          Start session
        </Button>
      </DialogActions>
    </Dialog>
  );
}
