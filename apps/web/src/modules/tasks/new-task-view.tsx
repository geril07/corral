import { describeError } from "@corral/client/rpc-errors";
import { taskSettingsFor, type ClientConfig, type LaunchProfile } from "@corral/protocol/config";
import type { CreateTaskInput, IssueProvider, Project, TaskSource } from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
import {
  Button,
  Combobox,
  ComboboxButton,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxSearch,
  ContentLane,
  FormError,
  FormField,
  Input,
  Textarea,
} from "../../common/ui/index.ts";
import { describeLaunchError } from "../sessions/index.ts";
import { IssueImportSection } from "./issue-import.tsx";
import {
  agentChoices,
  defaultAgent,
  defaultWorkspace,
  isBranchKey,
  workspaceChoices,
  type ComposerAgent,
  type ComposerWorkspace,
} from "./new-task-defaults.ts";

type BranchState =
  | { status: "loading" }
  | { status: "loaded"; names: string[] }
  | { status: "failed"; error: unknown };

type Branches = BranchState & { projectId: string };

export interface NewTaskViewProps {
  /** Every project a task can go to; the picker lists them. */
  projects: readonly Project[];
  /** The project to start on: the current one, or the one whose "new task" opened the view. */
  project: Project;
  /** A0's effective settings, read through `taskSettingsFor`; the view renders, it does not resolve. */
  config: ClientConfig;
  /** The valid launch profiles, in file order. */
  profiles: readonly LaunchProfile[];
  /** The branches "new worktree"'s neighbours offer, fetched again when the project changes. */
  loadBranches: (projectId: string) => Promise<string[]>;
  /** Creates the task and its primary agent; a rejection stays in the view with its input. */
  onCreate: (input: CreateTaskInput) => Promise<void>;
  /** Reads an issue only when the user asks; the project is the one picked now. */
  onResolveIssue: (
    projectId: string,
    input: { url: string; provider?: IssueProvider | undefined },
    signal: AbortSignal,
  ) => Promise<TaskSource>;
  /** True while `prefix t` (or a sidebar button) opened the view over a selected task. */
  opened: boolean;
  /** Escape: back to the task that was selected before the view opened. */
  onCancel: () => void;
}

/**
 * The prompt-first composer (`layout.md`, **New task view**), shown in the main area by `prefix t`
 * and whenever no task is selected. Enter creates, Shift+Enter is a newline, Escape goes back.
 * The task's seed title comes from the server; this view never derives one.
 */
export function NewTaskView({
  projects,
  project,
  config,
  profiles,
  loadBranches,
  onCreate,
  onResolveIssue,
  opened,
  onCancel,
}: NewTaskViewProps) {
  const [projectId, setProjectId] = useState(project.id);
  const selected = projects.find((candidate) => candidate.id === projectId) ?? project;
  const settings = taskSettingsFor(config, selected.path);

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<TaskSource>();
  const [importing, setImporting] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  // A prompt the user typed stays across project switches; one an import filled does not.
  const promptTyped = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [agentKey, setAgentKey] = useState<string>();
  const [workspaceKey, setWorkspaceKey] = useState<string>();
  const [branches, setBranches] = useState<Branches>({ projectId, status: "loading" });
  const attempt = useAttempt();
  // An IME commit is not a submission: Enter belongs to the composition while it runs, and Safari
  // ends the composition before that keydown. The mark is consumed by the next Enter, or cleared
  // by any other key, so a later Enter submits as usual.
  const ime = useRef({ composing: false, ended: false });

  // `autoFocus` only runs on mount. `prefix t` on an already-open composer (the no-task state)
  // must still hand the keyboard to the prompt, so the open transition focuses it again.
  useEffect(() => {
    if (!opened) return;
    promptRef.current?.focus();
  }, [opened]);

  useEffect(() => {
    let current = true;
    loadBranches(projectId).then(
      (names) => current && setBranches({ projectId, status: "loaded", names }),
      (error: unknown) => current && setBranches({ projectId, status: "failed", error }),
    );
    return () => {
      current = false;
    };
  }, [projectId, loadBranches]);

  // A list fetched for the previous project is not this project's; it reads as loading again.
  const branchState: BranchState =
    branches.projectId === projectId ? branches : { status: "loading" };

  const settingsAgent = defaultAgent(settings, profiles);
  // The entry the settings pick carries the configured model, so re-picking the agent already
  // shown keeps the model instead of falling back to the agent's native default.
  const agents = agentChoices(profiles).map((choice) =>
    choice.key === settingsAgent.key ? settingsAgent : choice,
  );
  const agent =
    (agentKey === undefined ? undefined : agents.find((choice) => choice.key === agentKey)) ??
    settingsAgent;
  const workspaces = workspaceChoices(branchState.status === "loaded" ? branchState.names : []);
  const workspace =
    (workspaceKey === undefined
      ? undefined
      : workspaces.find((choice) => choice.key === workspaceKey)) ?? defaultWorkspace(settings);

  // Only the values still taken from settings can claim to come from the project's overrides.
  const fromProject =
    (agentKey === undefined &&
      [settings.agent, settings.profile, settings.model].some(
        (each) => each.source === "project",
      )) ||
    (workspaceKey === undefined && settings.workspace.source === "project");

  const startComposition = () => {
    ime.current = { composing: true, ended: false };
  };
  const endComposition = () => {
    ime.current = { composing: false, ended: true };
  };
  /** Whether this Enter confirms a composition; consumes the one keydown that follows its end. */
  const compositionTakesEnter = () => {
    const busy = ime.current.composing || ime.current.ended;
    ime.current = { composing: ime.current.composing, ended: false };
    return busy;
  };

  const chooseProject = (next: string | null) => {
    if (next === null || next === projectId) return;
    setProjectId(next);
    // An existing branch, an issue snapshot and an imported prompt belong to the old project.
    if (workspaceKey !== undefined && isBranchKey(workspaceKey)) setWorkspaceKey(undefined);
    setSource(undefined);
    setImporting(false);
    if (!promptTyped.current) setPrompt("");
  };

  const fillPrompt = (value: string) => {
    promptTyped.current = false;
    setPrompt(value);
  };

  const promptText = prompt.trim();
  const titleText = title.trim();
  const ready =
    !attempt.pending &&
    !importing &&
    (promptText !== "" || titleText !== "" || source !== undefined);

  const submit = () => {
    if (!ready) return;
    void attempt.run(() =>
      onCreate({
        projectId,
        ...(promptText === "" ? {} : { prompt: promptText }),
        // An explicit title and an imported one are the user's; a prompt-only task gets the seed.
        ...(titleText === "" ? {} : { title: titleText }),
        ...(source === undefined ? {} : { source }),
        // A task without a prompt starts no agent yet (`design.md`, **Domain model → Task**).
        ...(promptText === "" ? {} : { agent: agent.choice }),
        workspace: workspace.input,
      }),
    );
  };

  const failure = attempt.failed
    ? (describeLaunchError(attempt.error) ?? describeError(attempt.error))
    : undefined;

  return (
    <div className="flex h-full min-h-0 justify-center overflow-y-auto px-4">
      <ContentLane>
        {/* About a third down (`layout.md`); the composer scrolls when the prompt grows. */}
        <div className="h-1/3 min-h-4 shrink-0" aria-hidden="true" />
        <form
          aria-label="New task"
          aria-busy={attempt.pending}
          className="flex flex-col gap-2 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onCompositionStart={startComposition}
          onCompositionEnd={endComposition}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              // A failed create keeps its error and the draft in view (`ux.md`: failed submissions
              // preserve input); leaving now would throw both away.
              if (attempt.failed) return;
              onCancel();
              return;
            }
            if (event.key !== "Enter") {
              ime.current = { composing: ime.current.composing, ended: false };
              return;
            }
            // Stop the implicit submission an Enter in the title field would otherwise trigger.
            if (event.nativeEvent.isComposing || compositionTakesEnter()) event.preventDefault();
          }}
        >
          <Textarea
            ref={promptRef}
            layout="prompt"
            aria-label="Prompt"
            placeholder="What should the agent do?"
            rows={4}
            autoFocus
            spellCheck={false}
            value={prompt}
            onChange={(event) => {
              promptTyped.current = true;
              setPrompt(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              // The form's handler consumes the composition mark, so only check it here.
              if (event.nativeEvent.isComposing || ime.current.composing || ime.current.ended)
                return;
              event.preventDefault();
              submit();
            }}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <ProjectPicker projects={projects} value={projectId} onChange={chooseProject} />
            <AgentPicker
              choices={agents}
              value={agent}
              onChange={(choice) => setAgentKey(choice.key)}
            />
            <WorkspacePicker
              choices={workspaces}
              value={workspace}
              onChange={(choice) => setWorkspaceKey(choice.key)}
            />
            <div className="ml-auto">
              <Button type="submit" disabled={!ready}>
                {attempt.pending ? "Creating…" : "Create task"}
              </Button>
            </div>
          </div>
          {fromProject && (
            <p className="m-0 text-xs text-muted-foreground">defaults from project settings</p>
          )}
          {branchState.status === "failed" && (
            <p className="m-0 text-xs text-muted-foreground">
              Could not list branches: {describeError(branchState.error)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {!titleOpen && (
              <Button variant="ghost" size="sm" onClick={() => setTitleOpen(true)}>
                Title (optional)
              </Button>
            )}
            {!issueOpen && (
              <Button variant="ghost" size="sm" onClick={() => setIssueOpen(true)}>
                From issue…
              </Button>
            )}
          </div>
          {titleOpen && (
            <FormField label="Title (optional)">
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </FormField>
          )}
          {issueOpen && (
            <IssueImportSection
              key={projectId}
              onResolveIssue={(input, signal) => onResolveIssue(projectId, input, signal)}
              source={source}
              onImported={(imported) => {
                setSource(imported);
                // The prompt carries the issue's title and link; a prompt the user typed stays.
                if (!promptTyped.current) fillPrompt(`${imported.title}\n\n${imported.url}`);
                // The next thing the user does is submit or edit that prompt, so it takes back the
                // keyboard from the import buttons.
                promptRef.current?.focus();
              }}
              onCleared={() => setSource(undefined)}
              onImportingChange={setImporting}
            />
          )}
          {failure !== undefined && (
            <>
              <FormError>{failure}</FormError>
              <p className="m-0 text-xs text-muted-foreground">
                Escape stays here until this is fixed.
              </p>
            </>
          )}
        </form>
      </ContentLane>
    </div>
  );
}

function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: readonly Project[];
  value: string;
  onChange: (projectId: string | null) => void;
}) {
  const ids = projects.map((project) => project.id);
  const selected = projects.find((project) => project.id === value);
  return (
    <Combobox items={ids} value={value} onValueChange={onChange} autoHighlight>
      <ComboboxButton aria-label={`Project ${selected?.name ?? value}`}>
        <span className="min-w-0 truncate">{selected?.name ?? value}</span>
      </ComboboxButton>
      <ComboboxContent>
        <div className="p-1">
          <ComboboxSearch aria-label="Search projects" placeholder="Search projects…" />
        </div>
        <ComboboxEmpty>No matching project.</ComboboxEmpty>
        <ComboboxList>
          {(id: string) => {
            const project = projects.find((each) => each.id === id);
            if (!project) return null;
            return (
              <ComboboxItem key={id} value={id}>
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="max-w-1/2 truncate text-xs text-muted-foreground">
                  {project.path}
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function AgentPicker({
  choices,
  value,
  onChange,
}: {
  choices: readonly ComposerAgent[];
  value: ComposerAgent;
  onChange: (choice: ComposerAgent) => void;
}) {
  return (
    <Combobox
      items={choices.map((choice) => choice.key)}
      value={value.key}
      onValueChange={(next) => {
        const picked = choices.find((choice) => choice.key === next);
        if (picked !== undefined) onChange(picked);
      }}
      autoHighlight
    >
      <ComboboxButton aria-label={`Agent ${value.label}`}>
        <span className="min-w-0 truncate">{value.label}</span>
      </ComboboxButton>
      <ComboboxContent>
        <div className="p-1">
          <ComboboxSearch aria-label="Search agents" placeholder="Search agents…" />
        </div>
        <ComboboxEmpty>No matching agent.</ComboboxEmpty>
        <ComboboxList>
          {(key: string) => {
            const choice = choices.find((candidate) => candidate.key === key);
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

function WorkspacePicker({
  choices,
  value,
  onChange,
}: {
  choices: readonly ComposerWorkspace[];
  value: ComposerWorkspace;
  onChange: (choice: ComposerWorkspace) => void;
}) {
  return (
    <Combobox
      items={choices.map((choice) => choice.key)}
      value={value.key}
      onValueChange={(next) => {
        const picked = choices.find((choice) => choice.key === next);
        if (picked !== undefined) onChange(picked);
      }}
      autoHighlight
    >
      <ComboboxButton aria-label={`Workspace ${value.label}`}>
        <span className="min-w-0 truncate">{value.label}</span>
      </ComboboxButton>
      <ComboboxContent>
        <div className="p-1">
          <ComboboxSearch aria-label="Search workspaces" placeholder="Search workspaces…" />
        </div>
        <ComboboxEmpty>No matching workspace.</ComboboxEmpty>
        <ComboboxList>
          {(key: string) => {
            const choice = choices.find((candidate) => candidate.key === key);
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
