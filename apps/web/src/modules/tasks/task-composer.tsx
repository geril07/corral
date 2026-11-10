import {
  taskSettingsFor,
  type AgentKind,
  type ClientConfig,
  type LaunchProfile,
  type ResolvedTaskSettings,
} from "@corral/protocol/config";
import type { CreateTaskInput, Project } from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
import { useEnterGuard } from "../../common/hooks/use-enter-guard.ts";
import {
  Button,
  Combobox,
  ComboboxButton,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxSearch,
  ComposerSurface,
  Hint,
  Icon,
  ModelPickerButton,
  Textarea,
} from "../../common/ui/index.ts";
import { ProjectOption, projectOptionLabel } from "../projects/index.ts";
import {
  AgentLaunchPicker,
  defaultLaunch,
  launchChoice,
  launchModel,
  launchName,
  launchProblem,
  launchView,
} from "../sessions/index.ts";
import { defaultWorkspace } from "./new-task-defaults.ts";
import type { TaskComposerDraft } from "./task-composer-draft.ts";

const NO_PROJECT = "\u0000none";

const COMPOSER_WORKSPACES: readonly {
  key: string;
  label: string;
  input: CreateTaskInput["workspace"];
}[] = [
  { key: "main-tree", label: "Main worktree", input: { type: "main-worktree" } },
  { key: "new-worktree", label: "New worktree", input: { type: "new-branch" } },
];

export interface TaskComposerProps {
  projects: readonly Project[];
  config: ClientConfig;
  profiles: readonly LaunchProfile[];
  chatDrivers: readonly AgentKind[];
  capabilitiesReady: boolean;
  draft: TaskComposerDraft;
  onDraftChange: (draft: TaskComposerDraft) => void;
  onCreate: (input: CreateTaskInput) => void;
  onCancel: () => void;
  /** Increments whenever the shell wants the prompt to take the keyboard. */
  focusRequest: number;
  onModalChange: (open: boolean) => void;
  creating: boolean;
  failure: string | undefined;
}

/**
 * The production task composer: prompt first, then one internal row with attach, instance/model
 * and reasoning on the left and send on the right; project and workspace sit below. It creates
 * nothing until Send, so a draft costs no agent turn. Attachments and pre-launch reasoning are
 * not in the server contract yet, and their controls say so instead of pretending.
 */
export function TaskComposer({
  projects,
  config,
  profiles,
  chatDrivers,
  capabilitiesReady,
  draft,
  onDraftChange,
  onCreate,
  onCancel,
  focusRequest,
  onModalChange,
  creating,
  failure,
}: TaskComposerProps) {
  const prompt = useRef<HTMLTextAreaElement>(null);
  const agentAnchor = useRef<HTMLButtonElement>(null);
  const [pickingAgent, setPickingAgent] = useState(false);
  const guard = useEnterGuard();

  useEffect(() => {
    if (focusRequest === 0) return;
    prompt.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    onModalChange(pickingAgent);
  }, [onModalChange, pickingAgent]);

  const project =
    draft.projectId === null
      ? undefined
      : projects.find((candidate) => candidate.id === draft.projectId);
  const settings: ResolvedTaskSettings =
    project === undefined ? config.tasks : taskSettingsFor(config, project.path);
  const agent = draft.agent ?? defaultLaunch(settings, profiles, config.agents);
  const agentProblem = agent ? launchProblem(agent, profiles, config.agents) : undefined;
  const configuredDisabled = configuredDefaultProblem(settings, profiles, config.agents);
  const view = launchView(settings, agent?.kind, chatDrivers);
  const workspace =
    COMPOSER_WORKSPACES.find((choice) => choice.key === draft.workspaceKey) ??
    workspaceFromSettings(settings);

  // The combobox restores focus to its trigger after the popup closes; hand it back to the prompt
  // afterwards, so a project/No project switch keeps typing where the user left it.
  const focusPromptSoon = () =>
    requestAnimationFrame(() => {
      prompt.current?.focus();
    });

  const promptText = draft.prompt.trim();
  const ready =
    !creating &&
    promptText !== "" &&
    (agent === undefined || (agentProblem === undefined && capabilitiesReady));

  const submit = () => {
    if (!ready) return;
    onCreate({
      projectId: draft.projectId,
      prompt: promptText,
      ...(agent === undefined ? {} : { agent: { ...launchChoice(agent), view } }),
      workspace: draft.projectId === null ? { type: "scratch" } : workspace.input,
    });
  };

  return (
    <div className="task-composer-shell">
      <form
        aria-label="New task"
        aria-busy={creating}
        className="task-composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onCompositionStart={guard.start}
        onCompositionEnd={guard.end}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (pickingAgent) return;
            event.preventDefault();
            event.stopPropagation();
            if (failure === undefined) onCancel();
            return;
          }
          if (event.key !== "Enter") {
            guard.noteKey(event.key);
            return;
          }
          if (guard.isComposition(event)) {
            guard.consume();
            event.preventDefault();
          }
        }}
      >
        <ComposerSurface>
          <Textarea
            frame="composer"
            layout="prompt"
            ref={prompt}
            aria-label="Prompt"
            placeholder="What should the agent do?"
            rows={4}
            autoFocus
            spellCheck={false}
            value={draft.prompt}
            onChange={(event) => onDraftChange({ ...draft, prompt: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (guard.isComposition(event)) {
                guard.consume();
                event.preventDefault();
                return;
              }
              if (event.shiftKey) return;
              event.preventDefault();
              submit();
            }}
          />
          <div className="task-composer-row">
            <div className="task-composer-row-left">
              <Hint content="File attachments are not supported by the server yet.">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Attach files"
                  aria-disabled="true"
                >
                  <Icon name="add" />
                </Button>
              </Hint>
              {agent !== undefined ? (
                <ModelPickerButton
                  ref={agentAnchor}
                  kind={agent.kind}
                  label={[launchName(agent), launchModel(agent)].filter(Boolean).join(" · ")}
                  aria-label={`Agent ${[launchName(agent), launchModel(agent)].filter(Boolean).join(" · ")}`}
                  onClick={() => setPickingAgent(true)}
                />
              ) : (
                <Hint content="Every agent is disabled in the config file, so this task starts no agent.">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="No agent available"
                    aria-disabled="true"
                  >
                    No agent
                  </Button>
                </Hint>
              )}
              <Hint content="Reasoning is reported by a running chat; there is no pre-launch reasoning contract yet.">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Reasoning unavailable before launch"
                  aria-disabled="true"
                >
                  Reasoning
                </Button>
              </Hint>
            </div>
            <div className="task-composer-row-right">
              <Button
                type="submit"
                size="icon-sm"
                aria-label={creating ? "Creating task" : "Create task"}
                disabled={!ready}
              >
                <Icon name="up" />
              </Button>
            </div>
          </div>
        </ComposerSurface>

        <div className="task-composer-context">
          <ProjectControl
            projects={projects}
            projectId={draft.projectId}
            onChange={(projectId) => {
              onDraftChange({ ...draft, projectId });
              focusPromptSoon();
            }}
          />
          {draft.projectId === null ? (
            <span className="task-composer-note">Scratch workspace · no Git controls</span>
          ) : (
            <>
              <WorkspaceControl
                value={workspace.key}
                onChange={(key) => {
                  onDraftChange({ ...draft, workspaceKey: key });
                  focusPromptSoon();
                }}
              />
              {project?.defaultBaseBranch !== undefined && (
                <span
                  className="task-composer-branch"
                  title="Read-only: a draft never changes which branch is checked out."
                >
                  <Icon name="branch" size="row" />
                  base {project.defaultBaseBranch}
                </span>
              )}
            </>
          )}
        </div>

        {configuredDisabled !== undefined && !pickingAgent && (
          <p className="task-composer-note">{configuredDisabled}</p>
        )}
        {agentProblem !== undefined && !pickingAgent && (
          <p className="task-composer-error" role="alert">
            {agentProblem}
          </p>
        )}
        {!capabilitiesReady && agent !== undefined && (
          <p className="task-composer-note">Loading agent capabilities…</p>
        )}
        {failure !== undefined && (
          <p className="task-composer-error" role="alert">
            {failure}
          </p>
        )}
      </form>

      {pickingAgent && agent !== undefined && (
        <AgentLaunchPicker
          title="Agent and model"
          context={draft.projectId === null ? {} : { projectId: draft.projectId }}
          anchor={agentAnchor}
          restoreFocus="composer"
          profiles={profiles}
          agents={config.agents}
          selection={agent}
          defaultSelection={defaultLaunch(settings, profiles, config.agents)}
          onChange={(next) => onDraftChange({ ...draft, agent: next })}
          onCommit={(target) => {
            if (launchProblem(target, profiles, config.agents) === undefined)
              setPickingAgent(false);
          }}
          onClose={() => setPickingAgent(false)}
          error={agentProblem}
          blocked={
            agentProblem !== undefined ||
            launchProblem({ ...agent, model: "" }, profiles, config.agents) !== undefined
          }
        />
      )}
    </div>
  );
}

/** The configured instance is honoured; when it is disabled the fallback is named, not silent. */
function configuredDefaultProblem(
  settings: ResolvedTaskSettings,
  profiles: readonly LaunchProfile[],
  agents: ClientConfig["agents"],
): string | undefined {
  const profile = settings.profile.value;
  if (profile !== null) {
    const found = profiles.find((candidate) => candidate.id === profile);
    if (found === undefined)
      return `The configured profile "${profile}" is disabled or missing; choose another agent.`;
    if (!agents[found.agent].enabled.value)
      return `The configured profile "${found.name}" uses the disabled ${found.agent} agent; choose another.`;
    return undefined;
  }
  const kind = settings.agent.value;
  if (kind !== null && !agents[kind].enabled.value)
    return `The configured ${kind} agent is disabled in the config file; choose another.`;
  return undefined;
}

function workspaceFromSettings(settings: ResolvedTaskSettings) {
  return COMPOSER_WORKSPACES.find((choice) => choice.key === draftWorkspaceKey(settings))!;
}

function draftWorkspaceKey(settings: ResolvedTaskSettings): string {
  return defaultWorkspace(settings).key === "new-worktree" ? "new-worktree" : "main-tree";
}

function ProjectControl({
  projects,
  projectId,
  onChange,
}: {
  projects: readonly Project[];
  projectId: string | null;
  onChange: (projectId: string | null) => void;
}) {
  const items = [NO_PROJECT, ...projects.map((project) => project.id)];
  const selected = projects.find((project) => project.id === projectId);
  const label = (id: string) => {
    if (id === NO_PROJECT) return "No project";
    const project = projects.find((candidate) => candidate.id === id);
    return project === undefined ? "Project unavailable" : projectOptionLabel(project);
  };
  return (
    <Combobox
      items={items}
      value={projectId ?? NO_PROJECT}
      onValueChange={(next) => onChange(next === NO_PROJECT ? null : next)}
      autoHighlight
      itemToStringLabel={label}
      filter={(id, query) => label(id).toLocaleLowerCase().includes(query.toLocaleLowerCase())}
    >
      <ComboboxButton aria-label={`Project ${selected?.name ?? "No project"}`}>
        <Icon name="project" size="row" />
        <span className="min-w-0 truncate">{selected?.name ?? "No project"}</span>
      </ComboboxButton>
      <ComboboxContent>
        <div className="p-1">
          <ComboboxSearch aria-label="Search projects" placeholder="Search projects…" />
        </div>
        <ComboboxEmpty>No matching project.</ComboboxEmpty>
        <ComboboxList>
          {(id: string) => {
            if (id === NO_PROJECT) {
              return (
                <ComboboxItem key={id} value={id} aria-label="No project">
                  <span className="min-w-0 flex-1 truncate">No project</span>
                  <span className="text-xs text-muted-foreground">scratch workspace</span>
                </ComboboxItem>
              );
            }
            const project = projects.find((candidate) => candidate.id === id);
            if (project === undefined) return null;
            return (
              <ComboboxItem key={id} value={id} aria-label={projectOptionLabel(project)}>
                <ProjectOption project={project} />
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function WorkspaceControl({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const selected = COMPOSER_WORKSPACES.find((choice) => choice.key === value)!;
  return (
    <Combobox
      items={COMPOSER_WORKSPACES.map((choice) => choice.key)}
      value={value}
      onValueChange={(next) => {
        if (next !== null && COMPOSER_WORKSPACES.some((choice) => choice.key === next))
          onChange(next);
      }}
      autoHighlight
    >
      <ComboboxButton aria-label={`Workspace ${selected.label}`}>
        <Icon name="project" size="row" />
        <span className="min-w-0 truncate">{selected.label}</span>
      </ComboboxButton>
      <ComboboxContent>
        <ComboboxList>
          {(key: string) => {
            const choice = COMPOSER_WORKSPACES.find((candidate) => candidate.key === key);
            if (choice === undefined) return null;
            return (
              <ComboboxItem key={key} value={key}>
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
