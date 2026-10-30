import { AGENTS } from "@corral/client/session-state";
import { describeError } from "@corral/client/rpc-errors";
import type { LaunchProfile } from "@corral/protocol/config";
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
  kind: AgentLaunchChoice["kind"];
  native: boolean;
  profile?: LaunchProfile;
}

const AGENT_ROW =
  "flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-active has-data-checked:bg-surface-active";

function choicesOf(profiles: readonly LaunchProfile[]): Choice[] {
  return [
    ...AGENTS.map((kind): Choice => ({ key: `native:${kind}`, kind, native: true })),
    ...profiles.map((profile): Choice => ({
      key: `profile:${profile.id}`,
      kind: profile.agent,
      native: false,
      profile,
    })),
  ];
}

/** What the profile leaves the model at; OpenCode has no model flag at all. */
function modelText(agent: LaunchProfile["agent"], model: string | null): string {
  if (model !== null) return model;
  return supportsModel(agent) ? "agent default model" : "env only";
}

/** A native agent or a named profile, plus an optional native model override where supported. */
export function AgentPicker({ profiles, onStart, onClose }: AgentPickerProps) {
  const choices = choicesOf(profiles);
  const [selected, setSelected] = useState(`native:${AGENTS[0] ?? "claude"}`);
  const [model, setModel] = useState("");
  const [failure, setFailure] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const choice = choices.find((candidate) => candidate.key === selected) ?? choices[0]!;
  const { profile } = choice;
  const offeredModel = supportsModel(choice.kind);

  const submit = (target: Choice = choice, includeModel = true) => {
    if (submitting) return;
    const invalid = includeModel ? modelProblem(target.kind, model) : undefined;
    if (invalid !== undefined) {
      setFailure(invalid);
      return;
    }
    setFailure(undefined);
    setSubmitting(true);
    const pickedModel =
      includeModel && supportsModel(target.kind) ? modelOverride(model) : undefined;
    void onStart({
      kind: target.kind,
      ...(target.profile === undefined ? {} : { profileId: target.profile.id }),
      ...(pickedModel === undefined ? {} : { model: pickedModel }),
    })
      .catch((error: unknown) => {
        setFailure(describeLaunchError(error) ?? describeError(error));
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog title="New agent session" onClose={onClose}>
      {failure && <FormError>{failure}</FormError>}
      <RadioGroup
        className="mb-1"
        aria-label="agent"
        value={selected}
        onValueChange={(key) => {
          setSelected(key);
          setFailure(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
            return;
          }
          const picked = AGENTS[Number(event.key) - 1];
          if (picked && /^[1-9]$/.test(event.key)) {
            event.preventDefault();
            submit({ key: `native:${picked}`, kind: picked, native: true }, false);
          }
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
                  {modelText(candidate.kind, candidate.profile?.model ?? null)}
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
            placeholder={profile?.model ?? "agent default"}
            onChange={(event) => {
              setModel(event.target.value);
              setFailure(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
          />
        </Field>
      )}
      <p className="mb-2 text-text-muted" aria-label="launch choice">
        {choice.native
          ? `${choice.kind} with the agent's native defaults.`
          : `${profile?.name}: ${choice.kind}, ${modelText(choice.kind, profile?.model ?? null)}${
              profile?.provider ? `, provider ${profile.provider}` : ""
            }.`}
      </p>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={submitting} onClick={() => submit()}>
          Start session
        </Button>
      </DialogActions>
    </Dialog>
  );
}
