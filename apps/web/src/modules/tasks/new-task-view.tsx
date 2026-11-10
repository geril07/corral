import { describeError } from "@corral/client/rpc-errors";
import { taskSettingsFor, type ClientConfig, type LaunchProfile } from "@corral/protocol/config";
import type {
  AgentKind,
  CreateTaskInput,
  IssueProvider,
  Project,
  TaskSource,
} from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
import { useAttempt } from "../../common/hooks/use-attempt.ts";
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
  ContentLane,
  ComposerSurface,
  ComposerToolbar,
  ModelPickerButton,
  OverflowMenu,
  DropdownMenuItem,
  FormError,
  FormField,
  Input,
  Textarea,
} from "../../common/ui/index.ts";
import { ProjectOption, projectOptionLabel } from "../projects/index.ts";
import {
  AgentLaunchPicker,
  LaunchViewControls,
  defaultLaunch,
  launchChoice,
  launchModel,
  launchName,
  launchProblem,
  launchView,
  describeLaunchError,
} from "../sessions/index.ts";
import { IssueImportSection } from "./issue-import.tsx";
import { draftForProject, movedDraft, type ComposerDraft } from "./new-task-draft.ts";
import { defaultWorkspace, workspaceChoices, type ComposerWorkspace } from "./new-task-defaults.ts";

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
  /** The agents this server build can show as chat (`chat.capabilities`); the view control reads it. */
  chatDrivers: readonly AgentKind[];
  capabilitiesReady: boolean;
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
  /** The composer's text and picks, owned by the workspace so a project navigation keeps them. */
  draft: ComposerDraft;
  onDraftChange: (draft: ComposerDraft) => void;
  /** How many times `prefix t` (or a sidebar button) opened the view; 0 means it was not opened. */
  opened: number;
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
  chatDrivers,
  capabilitiesReady,
  draft,
  onDraftChange,
  loadBranches,
  onCreate,
  onResolveIssue,
  opened,
  onCancel,
}: NewTaskViewProps) {
  const [projectId, setProjectId] = useState(project.id);
  const selected = projects.find((candidate) => candidate.id === projectId) ?? project;
  const settings = taskSettingsFor(config, selected.path);

  // The draft may still belong to the project the composer showed a moment ago (a remount after a
  // sidebar project pick): reading it through here drops only what that project owned.
  const current = draftForProject(draft, projectId);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const issueUrlRef = useRef<HTMLInputElement>(null);
  const issueWasOpen = useRef(current.issueOpen);
  const [importing, setImporting] = useState(false);
  const [pickingAgent, setPickingAgent] = useState(false);
  const agentAnchor = useRef<HTMLButtonElement>(null);
  const [branches, setBranches] = useState<Branches>({ projectId, status: "loading" });
  const attempt = useAttempt();
  // An IME commit is not a submission (`docs/ux.md`), in either platform ordering.
  const guard = useEnterGuard();

  // `autoFocus` only runs on mount. `prefix t` must also hand the keyboard to the prompt of a
  // composer that is already open (the no-task state, or one shown over a task), so it counts.
  useEffect(() => {
    if (opened === 0) return;
    promptRef.current?.focus();
  }, [opened]);

  // The issue field takes the keyboard when its section is first expanded, not when the section is
  // remounted for another project: the project picker keeps the focus it had.
  useEffect(() => {
    if (current.issueOpen && !issueWasOpen.current) issueUrlRef.current?.focus();
    issueWasOpen.current = current.issueOpen;
  }, [current.issueOpen]);

  useEffect(() => {
    let live = true;
    loadBranches(projectId).then(
      (names) => live && setBranches({ projectId, status: "loaded", names }),
      (error: unknown) => live && setBranches({ projectId, status: "failed", error }),
    );
    return () => {
      live = false;
    };
  }, [projectId, loadBranches]);

  // A list fetched for the previous project is not this project's; it reads as loading again.
  const branchState: BranchState =
    branches.projectId === projectId ? branches : { status: "loading" };

  const agent = current.agent ?? defaultLaunch(settings, profiles, config.agents);
  const agentProblem = agent ? launchProblem(agent, profiles, config.agents) : undefined;
  const wantedView = current.viewKey ?? settings.view.value;
  const view = launchView(
    { ...settings, view: { ...settings.view, value: wantedView } },
    agent?.kind,
    chatDrivers,
  );
  const workspaces = workspaceChoices(branchState.status === "loaded" ? branchState.names : []);
  const workspace =
    (current.workspaceKey === undefined
      ? undefined
      : workspaces.find((choice) => choice.key === current.workspaceKey)) ??
    defaultWorkspace(settings);

  // Only the values still taken from settings can claim to come from the project's overrides.
  const fromProject =
    (current.agent === undefined &&
      [settings.agent, settings.profile, settings.model].some(
        (each) => each.source === "project",
      )) ||
    (current.workspaceKey === undefined && settings.workspace.source === "project") ||
    (current.viewKey === undefined && settings.view.source === "project");
  // A configured chat view that this agent cannot show: the config warning covers a named agent;
  // this line covers the agent the user picked here. `chatDrivers` is empty until the server
  // answers `chat.capabilities`, so the line does not flash before the driver list is known.
  const viewFellBack = wantedView === "chat" && view !== "chat" && capabilitiesReady;

  const chooseProject = (next: string | null) => {
    if (next === null || next === projectId) return;
    setProjectId(next);
    setImporting(false);
    // One rule for every project change (this picker or a navigation remount): keep the user's
    // text, drop what only the old project owned (`movedDraft`).
    onDraftChange(movedDraft(current, next));
  };

  const promptText = current.prompt.trim();
  const titleText = current.title.trim();
  const ready =
    !attempt.pending &&
    !importing &&
    (promptText === "" ||
      agent === undefined ||
      (agentProblem === undefined && capabilitiesReady)) &&
    (promptText !== "" || titleText !== "" || current.source !== undefined);

  const submit = () => {
    if (!ready) return;
    void attempt.run(() =>
      onCreate({
        projectId,
        ...(promptText === "" ? {} : { prompt: promptText }),
        // An explicit title and an imported one are the user's; a prompt-only task gets the seed.
        ...(titleText === "" ? {} : { title: titleText }),
        ...(current.source === undefined ? {} : { source: current.source }),
        // A task without a prompt starts no agent yet (`design.md`, **Domain model → Task**).
        ...(promptText === "" || agent === undefined
          ? {}
          : { agent: { ...launchChoice(agent), view } }),
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
          onCompositionStart={guard.start}
          onCompositionEnd={guard.end}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              if (pickingAgent) return;
              event.preventDefault();
              event.stopPropagation();
              // A failed create keeps its error in view (`ux.md`: failed submissions preserve
              // input); leaving with Escape would hide what went wrong. The sidebar is the way out,
              // and the draft lives in the workspace, so it survives either path.
              if (attempt.failed) return;
              onCancel();
              return;
            }
            if (event.key !== "Enter") {
              // Any other key ends the Safari window in which an Enter would confirm a composition.
              guard.noteKey(event.key);
              return;
            }
            // Stop the implicit submission an Enter in the title field would otherwise trigger.
            if (guard.isComposition(event)) {
              guard.consume();
              event.preventDefault();
            }
          }}
        >
          <ComposerSurface>
            <Textarea
              frame="composer"
              ref={promptRef}
              layout="prompt"
              aria-label="Prompt"
              placeholder="What should the agent do?"
              rows={4}
              autoFocus
              spellCheck={false}
              value={current.prompt}
              onChange={(event) =>
                onDraftChange({ ...current, prompt: event.target.value, promptTyped: true })
              }
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // A confirming composition Enter is swallowed here; the form also blocks its default.
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
            <ComposerToolbar>
              {agent !== undefined && (
                <ModelPickerButton
                  ref={agentAnchor}
                  kind={agent.kind}
                  label={[launchName(agent), launchModel(agent)].filter(Boolean).join(" · ")}
                  aria-label={`Agent ${[launchName(agent), launchModel(agent)].filter(Boolean).join(" · ")}`}
                  onClick={() => setPickingAgent(true)}
                />
              )}
              <LaunchViewControls
                value={view}
                kind={agent?.kind}
                chatDrivers={chatDrivers}
                onChange={(viewKey) => onDraftChange({ ...current, viewKey })}
              />
              <div className="ml-auto">
                <Button type="submit" disabled={!ready}>
                  {attempt.pending ? "Creating…" : "Create task"}
                </Button>
              </div>
            </ComposerToolbar>
          </ComposerSurface>
          <div className="flex flex-wrap items-center gap-1.5">
            <ProjectPicker projects={projects} value={projectId} onChange={chooseProject} />
            <WorkspacePicker
              choices={workspaces}
              value={workspace}
              onChange={(choice) => onDraftChange({ ...current, workspaceKey: choice.key })}
            />
            <div className="ml-auto">
              <OverflowMenu label="Task setup actions">
                <DropdownMenuItem
                  disabled={current.issueOpen}
                  onClick={() => onDraftChange({ ...current, issueOpen: true })}
                >
                  From issue…
                </DropdownMenuItem>
              </OverflowMenu>
            </div>
          </div>
          {pickingAgent && agent !== undefined && (
            <AgentLaunchPicker
              title="Agent and model"
              context={projectId ? { projectId } : {}}
              anchor={agentAnchor}
              restoreFocus="composer"
              profiles={profiles}
              agents={config.agents}
              selection={agent}
              defaultSelection={defaultLaunch(settings, profiles, config.agents)}
              onChange={(next) => onDraftChange({ ...current, agent: next })}
              onCommit={(target) => {
                if (!launchProblem(target, profiles, config.agents)) setPickingAgent(false);
              }}
              onClose={() => setPickingAgent(false)}
              error={agentProblem}
              blocked={!!launchProblem({ ...agent, model: "" }, profiles, config.agents)}
            />
          )}
          {agentProblem && !pickingAgent && <FormError>{agentProblem}</FormError>}
          {!capabilitiesReady && agent && (
            <p className="m-0 text-xs text-muted-foreground">Loading agent capabilities…</p>
          )}
          {fromProject && (
            <p className="m-0 text-xs text-muted-foreground">defaults from project settings</p>
          )}
          {agent === undefined && (
            <p className="m-0 text-xs text-muted-foreground">
              Every agent is disabled in the config file, so this task starts no agent.
            </p>
          )}
          {viewFellBack && (
            <p className="m-0 text-xs text-muted-foreground">
              The chat view needs an agent with a chat driver, so this task opens in the terminal.
            </p>
          )}
          {branchState.status === "failed" && (
            <p className="m-0 text-xs text-muted-foreground">
              Could not list branches: {describeError(branchState.error)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {!current.titleOpen && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDraftChange({ ...current, titleOpen: true })}
              >
                Title (optional)
              </Button>
            )}
          </div>
          {current.titleOpen && (
            <FormField label="Title (optional)">
              <Input
                value={current.title}
                onChange={(event) => onDraftChange({ ...current, title: event.target.value })}
                autoComplete="off"
                autoFocus
              />
            </FormField>
          )}
          {current.issueOpen && (
            <IssueImportSection
              key={projectId}
              inputRef={issueUrlRef}
              onResolveIssue={(input, signal) => onResolveIssue(projectId, input, signal)}
              source={current.source}
              onImported={(imported) => {
                // The prompt carries the issue's title and link; a prompt the user typed stays.
                onDraftChange({
                  ...current,
                  source: imported,
                  ...(current.promptTyped
                    ? {}
                    : { prompt: `${imported.title}\n\n${imported.url}`, promptTyped: false }),
                });
                // The next thing the user does is submit or edit that prompt, so it takes back the
                // keyboard from the import buttons.
                promptRef.current?.focus();
              }}
              onCleared={() => onDraftChange({ ...current, source: undefined })}
              onImportingChange={setImporting}
            />
          )}
          {failure !== undefined && (
            <>
              <FormError>{failure}</FormError>
              <p className="m-0 text-xs text-muted-foreground">
                Fix what failed, or pick another task in the sidebar.
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
  const label = (id: string) => {
    const project = projects.find((each) => each.id === id);
    return project ? projectOptionLabel(project) : id;
  };
  return (
    <Combobox
      items={ids}
      value={value}
      onValueChange={onChange}
      autoHighlight
      itemToStringLabel={label}
      filter={(id, query) => label(id).toLocaleLowerCase().includes(query.toLocaleLowerCase())}
    >
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
