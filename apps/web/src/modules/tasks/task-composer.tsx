import { describeError } from "@corral/client/rpc-errors";
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
import { ProjectChoiceDialog } from "../projects/index.ts";
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

/** The two ways a project draft can run: the checkout it starts on, or a fresh worktree. */
const COMPOSER_WORKSPACES: readonly {
  key: string;
  label: string;
}[] = [
  { key: "main-tree", label: "Current checkout" },
  { key: "new-worktree", label: "New worktree" },
];

const WORKTREE = "new-worktree";

interface BranchState {
  projectId: string;
  status: "loaded" | "failed";
  names: readonly string[];
  error?: string | undefined;
}

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
  /** Pins a project from the picker the project name opens. */
  onSetPinned: (id: string, pinned: boolean) => Promise<void>;
  /** Branches a new worktree can start from, read again whenever the draft's project changes. */
  loadBranches: (projectId: string, signal: AbortSignal) => Promise<string[]>;
  /** Increments whenever the shell wants the prompt to take the keyboard. */
  focusRequest: number;
  onModalChange: (open: boolean) => void;
  creating: boolean;
  failure: string | undefined;
}

/**
 * The production task composer: prompt first, then one internal row with attach, instance/model
 * and reasoning on the left and send on the right. Below it one context row names the project,
 * the workspace and its branch. It creates nothing until Send, so a draft costs no agent turn.
 * Attachments and pre-launch reasoning are not in the server contract yet, and their controls say
 * so instead of pretending.
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
  onSetPinned,
  loadBranches,
  focusRequest,
  onModalChange,
  creating,
  failure,
}: TaskComposerProps) {
  const prompt = useRef<HTMLTextAreaElement>(null);
  const agentAnchor = useRef<HTMLButtonElement>(null);
  const [pickingAgent, setPickingAgent] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const [branches, setBranches] = useState<BranchState>();
  const guard = useEnterGuard();

  useEffect(() => {
    if (focusRequest === 0) return;
    prompt.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    onModalChange(pickingAgent || pickingProject);
  }, [onModalChange, pickingAgent, pickingProject]);

  const project =
    draft.projectId === null
      ? undefined
      : projects.find((candidate) => candidate.id === draft.projectId);
  const projectId = project?.id;
  const settings: ResolvedTaskSettings =
    project === undefined ? config.tasks : taskSettingsFor(config, project.path);
  const agent = draft.agent ?? defaultLaunch(settings, profiles, config.agents);
  const agentProblem = agent ? launchProblem(agent, profiles, config.agents) : undefined;
  const configuredDisabled = configuredDefaultProblem(settings, profiles, config.agents);
  const view = launchView(settings, agent?.kind, chatDrivers);
  const workspace =
    COMPOSER_WORKSPACES.find((choice) => choice.key === draft.workspaceKey) ??
    workspaceFromSettings(settings);
  const baseBranch = draft.baseBranch ?? project?.defaultBaseBranch ?? "";
  const branchState = branches?.projectId === projectId ? branches : undefined;
  // `projects.branches` answers only targets a worktree can check out, so the project's own
  // default base (usually checked out in the main tree) is merged back as the first choice: it is
  // a real base and the one the row starts on.
  const branchNames = branchState?.names ?? [];
  const branchChoices =
    project !== undefined &&
    project.defaultBaseBranch !== "" &&
    !branchNames.includes(project.defaultBaseBranch)
      ? [project.defaultBaseBranch, ...branchNames]
      : branchNames;

  // OpenCode preloads branches before its picker opens; the project is the only key, so one read
  // serves both the read-only fact and the picker and a change of project cannot mix two lists.
  useEffect(() => {
    if (projectId === undefined) return undefined;
    const controller = new AbortController();
    loadBranches(projectId, controller.signal).then(
      (names) => {
        if (!controller.signal.aborted) setBranches({ projectId, status: "loaded", names });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setBranches({ projectId, status: "failed", names: [], error: describeError(error) });
      },
    );
    return () => controller.abort();
  }, [loadBranches, projectId]);

  // The pickers restore focus to their triggers after a popup closes; hand it back to the prompt
  // afterwards, so a project/workspace/branch switch keeps typing where the user left it.
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
      workspace:
        draft.projectId === null
          ? { type: "scratch" }
          : workspace.key !== WORKTREE
            ? { type: "main-worktree" }
            : baseBranch === ""
              ? { type: "new-branch" }
              : { type: "new-branch", baseBranch },
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
            if (pickingAgent || pickingProject || event.defaultPrevented) return;
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            layout="text"
            aria-label={`Project ${project?.name ?? "No project"}`}
            aria-haspopup="dialog"
            onClick={() => setPickingProject(true)}
          >
            <Icon name="project" size="row" />
            <span className="min-w-0 truncate">{project?.name ?? "No project"}</span>
          </Button>
          {project !== undefined && (
            <>
              <span className="task-composer-separator" aria-hidden="true">
                /
              </span>
              <Combobox
                items={COMPOSER_WORKSPACES.map((choice) => choice.key)}
                value={workspace.key}
                onValueChange={(next) => {
                  if (next === null || !COMPOSER_WORKSPACES.some((choice) => choice.key === next))
                    return;
                  onDraftChange({
                    ...draft,
                    workspaceKey: next,
                    baseBranch:
                      next === WORKTREE
                        ? (draft.baseBranch ?? project.defaultBaseBranch)
                        : baseBranch,
                  });
                  focusPromptSoon();
                }}
                autoHighlight
              >
                <ComboboxButton
                  layout="text"
                  chevron={false}
                  aria-label={`Workspace ${workspace.label}`}
                >
                  <Icon name={workspace.key === WORKTREE ? "add" : "project"} size="row" />
                  <span className="min-w-0 truncate">{workspace.label}</span>
                </ComboboxButton>
                <ComboboxContent align="start">
                  <ComboboxList scrollbar="visible">
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
              <span className="task-composer-separator" aria-hidden="true">
                /
              </span>
              {workspace.key === WORKTREE ? (
                <BranchControl
                  names={branchChoices}
                  status={branchState?.status ?? "loading"}
                  error={branchState?.error}
                  value={baseBranch}
                  onChange={(branch) => {
                    onDraftChange({ ...draft, baseBranch: branch });
                    focusPromptSoon();
                  }}
                />
              ) : (
                <span className="task-composer-branch">
                  <Icon name="branch" size="row" />
                  <span className="min-w-0 truncate">{baseBranch}</span>
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

      {pickingProject && (
        <ProjectChoiceDialog
          projects={projects}
          onChoose={(chosenId) => {
            onDraftChange({
              ...draft,
              projectId: chosenId,
              baseBranch: draft.projectId === chosenId ? draft.baseBranch : undefined,
            });
            setPickingProject(false);
          }}
          onSetPinned={onSetPinned}
          onClose={() => setPickingProject(false)}
          finalFocus={() => prompt.current}
        />
      )}

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

function BranchControl({
  names,
  status,
  error,
  value,
  onChange,
}: {
  names: readonly string[];
  status: "loading" | BranchState["status"];
  error: string | undefined;
  value: string;
  onChange: (branch: string) => void;
}) {
  return (
    <Combobox
      items={names}
      value={value}
      onValueChange={(next) => {
        if (next === null) return;
        onChange(next);
      }}
      autoHighlight
    >
      <ComboboxButton layout="text" aria-label={`Base branch ${value}`}>
        <Icon name="branch" size="row" />
        <span className="min-w-0 truncate">from {value}</span>
      </ComboboxButton>
      <ComboboxContent align="start">
        <ComboboxSearch
          variant="band"
          aria-label="Search branches"
          placeholder="Search branches"
          autoFocus
        />
        {status === "failed" ? (
          <p className="task-composer-branch-error" role="alert">
            {error}
          </p>
        ) : (
          <ComboboxEmpty>No results found</ComboboxEmpty>
        )}
        <ComboboxList scrollbar="visible">
          {(name: string) => (
            <ComboboxItem key={name} value={name}>
              <span className="min-w-0 flex-1 truncate">{name}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
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
  return defaultWorkspace(settings).key === WORKTREE ? WORKTREE : "main-tree";
}
