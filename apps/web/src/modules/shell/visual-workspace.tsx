import { hasUnseen } from "@corral/client/agent-status";
import { describeError } from "@corral/client/rpc-errors";
import { activeAfterClose } from "@corral/client/terminal-selection";
import { taskSettingsFor, type ActionId } from "@corral/protocol/config";
import type { CreateTaskInput, Task } from "@corral/protocol/rpc";
import { workspaceMissingPath } from "@corral/protocol/workspace";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNow } from "../../common/hooks/use-now.ts";
import {
  useDialogFocus,
  VisualTabPanel,
  VisualTabStrip,
  type VisualTabItem,
} from "../../common/ui/index.ts";
import { createChangesActions } from "../changes/index.ts";
import { ConnectionRecoveryDialog, useConnection, useCorralClient } from "../connection/index.ts";
import { bindingOf, ConfigProblemsDialog, useConfig } from "../keymap/index.ts";
import { AddProjectDialog, ProjectChoiceDialog } from "../projects/index.ts";
import { defaultLaunch, describeLaunchError } from "../sessions/index.ts";
import { useAppearance } from "../settings/index.ts";
import {
  RemoveTaskDialog,
  TaskComposer,
  TaskSourceDialog,
  workspaceGoneNotice,
  type TaskComposerDraft,
} from "../tasks/index.ts";
import { FindTaskDialog, RenameDialog, type RenameTarget } from "../workspace/index.ts";
import {
  draftForProject,
  draftHasContent,
  newTaskDraft,
  updateDraftComposer,
} from "./task-drafts.ts";
import { DRAFT_STORAGE_NOTICE, useTaskDrafts } from "./use-task-drafts.ts";
import { useTaskWorkspace } from "./task-workspace.tsx";

import {
  TaskMain,
  VisualShellView,
  type VisualRowFocus,
  type VisualShellNotice,
  type VisualTaskActions,
} from "./visual-view.tsx";
import { buildSettledRows, buildTaskRows, primaryTaskStatus } from "./visual-status.ts";

/** The open removal and its preflight answer. */
interface RemoveState {
  task: Task;
  workspaceMissing: boolean;
}

/** The pane the open draft's tab controls; the composer is its content. */
const DRAFT_PANE_ID = "task-draft-pane";

/** The prefix's numbered chords, the same nine a task's strip uses. */
const NUMBER_ACTIONS = [
  "session-1",
  "session-2",
  "session-3",
  "session-4",
  "session-5",
  "session-6",
  "session-7",
  "session-8",
  "session-9",
] as const satisfies readonly ActionId[];

/** The failure map without one draft's entry; the same map when it had none. */
function withoutError(errors: ReadonlyMap<number, string>, key: number) {
  if (!errors.has(key)) return errors;
  const next = new Map(errors);
  next.delete(key);
  return next;
}

/**
 * The live shell: independent read-only stores, the production task composer, and one keymap
 * listener for the prefix and the three direct creation commands. Opening a draft writes nothing;
 * only Send calls `tasks.create`.
 */
export function VisualWorkspace({
  selectedTaskId,
  onSelectTask,
  onOpenSettings,
  active = true,
}: {
  selectedTaskId: string | null | undefined;
  onSelectTask: (id: string) => void;
  onOpenSettings: () => void;
  /** False while Settings or the board covers the shell, so neither route's keys are stolen. */
  active?: boolean;
}) {
  const client = useCorralClient();
  const connection = useConnection();
  const dialogFocus = useDialogFocus();
  const { config, profiles, loaded: configLoaded, problems: configProblems } = useConfig();
  const { appearance } = useAppearance();
  const now = useNow(30_000);
  const projects = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const tasks = useSyncExternalStore(client.tasks.subscribe, client.tasks.getSnapshot);
  const sessions = useSyncExternalStore(client.sessions.subscribe, client.sessions.getSnapshot);
  const terminals = useSyncExternalStore(client.terminals.subscribe, client.terminals.getSnapshot);
  const chatCapabilities = useSyncExternalStore(
    client.chatCapabilities.subscribe,
    client.chatCapabilities.getSnapshot,
  );
  const projectsFailure = useSyncExternalStore(
    client.projects.failure.subscribe,
    client.projects.failure.getSnapshot,
  );
  const tasksFailure = useSyncExternalStore(
    client.tasks.failure.subscribe,
    client.tasks.failure.getSnapshot,
  );
  const sessionFailure = useSyncExternalStore(
    client.sessions.failure.subscribe,
    client.sessions.failure.getSnapshot,
  );
  const [addingProject, setAddingProject] = useState(false);
  const [projectChoice, setProjectChoice] = useState(false);
  const [finding, setFinding] = useState(false);
  // Whether the open project choice ended in a draft. The picker is replaced by the composer in one
  // commit, so the dialog's final-focus callback reads this ref instead of the render it closed in.
  const pickedProject = useRef(false);
  const { drafts, draftsRef, change: changeDrafts, storageFailed } = useTaskDrafts();
  const [activeDraftId, setActiveDraftIdState] = useState<string>();
  const activeDraftIdRef = useRef<string | undefined>(activeDraftId);
  // The ref carries the open draft before React commits, so a create's completion knows whether
  // its draft is still the one on screen.
  const setActiveDraftId = useCallback(
    (id: string | undefined) => {
      activeDraftIdRef.current = id;
      setActiveDraftIdState(id);
    },
    [setActiveDraftIdState],
  );
  const activeDraft = drafts.find((entry) => entry.id === activeDraftId);
  const [focusRequest, setFocusRequest] = useState(0);
  const [composerModal, setComposerModal] = useState(false);
  // Creates in flight, by draft incarnation. A draft's busy state is its own: a create from a
  // closed draft must not keep the next one from submitting.
  const [creatingKeys, setCreatingKeys] = useState<readonly number[]>([]);
  const [createErrors, setCreateErrors] = useState<ReadonlyMap<number, string>>(() => new Map());
  const creating = activeDraft !== undefined && creatingKeys.includes(activeDraft.key);
  const createError = activeDraft === undefined ? undefined : createErrors.get(activeDraft.key);
  const [rename, setRename] = useState<RenameTarget>();
  const [remove, setRemove] = useState<RemoveState>();
  const [source, setSource] = useState<Task>();
  const [notice, setNotice] = useState<VisualShellNotice>();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [configProblemsOpen, setConfigProblemsOpen] = useState(false);
  // A refused write keeps its one notice until the user dismisses it; it never takes the slot from
  // a notice that already says something about the action at hand.
  const [storageNoticeDismissed, setStorageNoticeDismissed] = useState(false);
  // The discard whose Undo the current notice carries. A create for that draft's project clears
  // the notice, so Undo cannot bring back text that has already been sent.
  const discardUndo = useRef<{ notice: VisualShellNotice; projectId: string | null } | undefined>(
    undefined,
  );
  const listFocus = useRef<VisualRowFocus | null>(null);

  const removeRead = useRef<AbortController | undefined>(undefined);
  const removeSucceeded = useRef(false);
  const removeCurrent = useRef<string | undefined>(undefined);
  const removeNext = useRef<string | undefined>(undefined);
  const browse = useCallback(
    (path: string, signal: AbortSignal) =>
      client.connection.api.projects.directories({ path }, { signal }),
    [client],
  );

  const rows = useMemo(
    () => buildTaskRows(projects.projects, tasks.tasks, sessions.sessions, now),
    [now, projects.projects, sessions.sessions, tasks.tasks],
  );
  const settledRows = useMemo(
    () => buildSettledRows(projects.projects, tasks.tasks, sessions.sessions, now),
    [now, projects.projects, sessions.sessions, tasks.tasks],
  );
  // The shelf is part of the one list: a settled task stays selectable, and its working area keeps
  // its tabs and its running sessions, because settling is metadata only.
  const listedRows = useMemo(() => [...rows, ...settledRows], [rows, settledRows]);
  const selectedRow =
    selectedTaskId === null
      ? undefined
      : (listedRows.find((row) => row.id === selectedTaskId) ?? rows[0]);
  const currentProjectId =
    selectedRow === undefined
      ? null
      : (tasks.tasks.find((task) => task.id === selectedRow.id)?.projectId ?? null);
  const failure = projectsFailure ?? tasksFailure ?? sessionFailure;
  const binding = bindingOf(config, "toggle-sidebar");
  const newTaskBinding = bindingOf(config, "new-task");
  const settingsBinding = bindingOf(config, "settings");
  const renameBinding = bindingOf(config, "rename-task");
  const removeBinding = bindingOf(config, "remove-task");
  const addProjectBinding = bindingOf(config, "add-project");
  const findTaskBinding = bindingOf(config, "find-task");
  const focusSidebarBinding = bindingOf(config, "focus-sidebar");
  const settleBinding = bindingOf(config, "settle-task");
  const prefix = config.keys.prefix;
  const shortcut = useMemo(
    () => (binding === null ? undefined : { prefix, binding }),
    [binding, prefix],
  );
  const newTaskShortcut = useMemo(
    () => (newTaskBinding === null ? undefined : { prefix, binding: newTaskBinding }),
    [newTaskBinding, prefix],
  );
  const findTaskShortcut = useMemo(
    () => (findTaskBinding === null ? undefined : { prefix, binding: findTaskBinding }),
    [findTaskBinding, prefix],
  );
  const settingsShortcut = useMemo(
    () => (settingsBinding === null ? undefined : { prefix, binding: settingsBinding }),
    [prefix, settingsBinding],
  );
  const renameShortcut = useMemo(
    () => (renameBinding === null ? undefined : { prefix, binding: renameBinding }),
    [prefix, renameBinding],
  );
  const removeShortcut = useMemo(
    () => (removeBinding === null ? undefined : { prefix, binding: removeBinding }),
    [prefix, removeBinding],
  );
  const focusSidebarShortcut = useMemo(
    () => (focusSidebarBinding === null ? undefined : { prefix, binding: focusSidebarBinding }),
    [focusSidebarBinding, prefix],
  );
  const settleShortcut = useMemo(
    () => (settleBinding === null ? undefined : { prefix, binding: settleBinding }),
    [prefix, settleBinding],
  );

  const findTask = useCallback(
    (id: string) => tasks.tasks.find((task) => task.id === id),
    [tasks.tasks],
  );

  const taskActions = useMemo<VisualTaskActions>(
    () => ({
      onRename: (id) => {
        const task = findTask(id);
        if (task === undefined) return;
        setRename({ type: "task", id, name: task.title, value: task.title });
      },
      onRemove: (id) => {
        const task = findTask(id);
        if (task === undefined) return;
        removeSucceeded.current = false;
        setRemove({ task, workspaceMissing: false });
        if (!task.ownsWorktree) return;
        // `tasks.remove` returns nothing, so the question is answered before it is asked: the
        // same read the Changes tab shows tells whether the directory is already gone.
        const controller = new AbortController();
        removeRead.current = controller;
        void client.connection.api.changes
          .files({ id })
          .then((snapshot) => {
            if (controller.signal.aborted) return;
            const workspaceMissing = workspaceMissingPath(snapshot.error ?? "") !== undefined;
            setRemove((open) => (open?.task.id === id ? { ...open, workspaceMissing } : open));
          })
          .catch(() => undefined);
      },
      onViewSource: (id) => {
        const task = findTask(id);
        if (task?.source !== undefined) setSource(task);
      },
      onToggleSettle: async (id) => {
        const task = findTask(id);
        if (task === undefined) return false;
        setNotice(undefined);
        const state = task.state === "active" ? "settled" : "active";
        // The server owns the state: settling stops the running sessions, continuing resumes the
        // ones that were running (`design.md`, **Domain model** — Task).
        try {
          const updated = await client.connection.api.tasks.setState({ id, state });
          // The server answers early without notifying when it already had this state, so compare
          // against what this client saw: only a real change moves the row.
          return updated.state === state && task.state !== state;
        } catch (error) {
          setNotice({ message: describeError(error), tone: "error" });
          return false;
        }
      },
    }),
    [client, findTask],
  );

  const saveRename = useCallback(
    (target: RenameTarget, name: string | null) => {
      if (target.type !== "task" || name === null) return;
      setNotice(undefined);
      void client.connection.api.tasks
        .rename({ id: target.id, title: name })
        .catch((error: unknown) => setNotice({ message: describeError(error), tone: "error" }));
    },
    [client],
  );

  const closeRemove = useCallback(() => {
    removeRead.current?.abort();
    setRemove(undefined);
  }, []);

  const removeTask = useCallback(
    async (task: Task, force: boolean) => {
      // Read once more at confirm time: a read that failed must not become a silent prune.
      let workspaceMissing = false;
      if (task.ownsWorktree) {
        const snapshot = await client.connection.api.changes.files({ id: task.id });
        workspaceMissing = workspaceMissingPath(snapshot.error ?? "") !== undefined;
      }
      // Rows re-sort while the dialog is open, so the neighbour is read from the list of this
      // moment, not from the one that opened the menu.
      const currentId = selectedRow?.id;
      const nextId = activeAfterClose(
        listedRows.map((row) => row.id),
        task.id,
      );
      removeCurrent.current = currentId;
      removeNext.current = nextId;
      await client.connection.api.tasks.remove({ id: task.id, force });
      removeSucceeded.current = true;
      if (currentId === task.id && nextId !== undefined) onSelectTask(nextId);
      if (workspaceMissing) {
        setNotice({ message: workspaceGoneNotice, tone: "notice" });
      }
    },
    [client, listedRows, onSelectTask, selectedRow],
  );

  const addProjectShortcut = useMemo(
    () => (addProjectBinding === null ? undefined : { prefix, binding: addProjectBinding }),
    [addProjectBinding, prefix],
  );

  /**
   * Escape and a task selection take the working area back; the drafts stay where they are and
   * the next New task for the same project returns to one (`docs/layout.md`).
   */
  const hideDraft = useCallback(() => setActiveDraftId(undefined), [setActiveDraftId]);

  const updateDraft = useCallback(
    (next: TaskComposerDraft) => {
      const id = activeDraftIdRef.current;
      if (id === undefined) return;
      const update = updateDraftComposer(draftsRef.current, id, next);
      // A project has one draft, and the one that already has text is the one you get: the
      // composer opens it instead of moving this draft onto it.
      if (update.openId !== undefined) {
        setActiveDraftId(update.openId);
        setFocusRequest((request) => request + 1);
        return;
      }
      changeDrafts(() => update.drafts);
    },
    [changeDrafts, draftsRef, setActiveDraftId, setFocusRequest],
  );

  const openDraft = useCallback(
    (projectId: string | null) => {
      const project =
        projectId === null
          ? undefined
          : projects.projects.find((candidate) => candidate.id === projectId);
      const settings = project === undefined ? config.tasks : taskSettingsFor(config, project.path);
      // Before the server's config arrives, the defaults may not name the real agent; leave the
      // draft unpinned so it follows the loaded config instead of freezing the placeholder.
      const opening = configLoaded ? defaultLaunch(settings, profiles, config.agents) : undefined;
      // One draft per project, reused (T3): an existing draft comes back with its text and picks.
      const existing = draftForProject(draftsRef.current, projectId);
      pickedProject.current = true;
      setProjectChoice(false);
      if (existing === undefined) {
        // Pin the launch the draft opened with. A later config edit then shows an invalidation
        // instead of silently swapping the runtime under the same prompt (`docs/layout.md`).
        const opened = newTaskDraft(projectId, opening);
        changeDrafts((current) => [...current, opened]);
        setActiveDraftId(opened.id);
      } else {
        setActiveDraftId(existing.id);
      }
      setFocusRequest((request) => request + 1);
    },
    [
      changeDrafts,
      config,
      configLoaded,
      draftsRef,
      profiles,
      projects.projects,
      setActiveDraftId,
      setFocusRequest,
    ],
  );

  const selectDraft = useCallback(
    (id: string) => {
      setActiveDraftId(id);
      setFocusRequest((request) => request + 1);
    },
    [setActiveDraftId, setFocusRequest],
  );

  /**
   * Closing a draft tab discards it, as OpenCode's close does for a draft: the tab and what was
   * typed go together. T3 makes exactly this action undoable, so the sidebar notice keeps the
   * removed draft and puts it back until the notice is replaced or dismissed. Escape is the way
   * out that keeps the draft without a notice.
   */
  const discardDraft = useCallback(
    (id: string) => {
      const current = draftsRef.current;
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      const discarded = current[index]!;
      const next = current[index + 1] ?? current[index - 1];
      changeDrafts((all) => all.filter((entry) => entry.id !== id));
      const discardedNotice: VisualShellNotice = {
        message: "Discarded",
        tone: "notice",
        action: {
          label: "Undo",
          run: () => {
            const replacement = draftsRef.current.find(
              (entry) =>
                entry.id !== discarded.id &&
                entry.composer.projectId === discarded.composer.projectId,
            );
            // T3 refuses to restore over a draft with new content; an empty one has nothing to
            // lose and is dropped, so the restored draft keeps the one-draft-per-project rule.
            if (replacement !== undefined && draftHasContent(replacement)) {
              setNotice({ message: "The draft has new content.", tone: "error" });
              return;
            }
            const open = activeDraftIdRef.current;
            changeDrafts((all) => {
              if (all.some((entry) => entry.id === discarded.id)) return all;
              const rest = all.filter(
                (entry) => entry.composer.projectId !== discarded.composer.projectId,
              );
              const at = Math.min(index, rest.length);
              return [...rest.slice(0, at), discarded, ...rest.slice(at)];
            });
            setNotice(undefined);
            // The strip only shows with an open draft, so a restore with none reopens it; so does
            // a restore that drops the open draft, which is what New task reopening the project
            // after the discard left there. A tab that comes back beside another draft does not
            // take the keyboard.
            if (open === undefined || open === replacement?.id) {
              setActiveDraftId(discarded.id);
              setFocusRequest((request) => request + 1);
            }
          },
        },
      };
      discardUndo.current = { notice: discardedNotice, projectId: discarded.composer.projectId };
      setNotice(discardedNotice);
      if (activeDraftIdRef.current !== id) return;
      setActiveDraftId(next?.id);
      if (next !== undefined) {
        setFocusRequest((request) => request + 1);
        return;
      }
      // The working area fell back to the selected task; the shell names the target, and it always
      // has one, so the keyboard never falls to `<body>`.
      requestAnimationFrame(() => listFocus.current?.fallbackElement()?.focus());
    },
    [changeDrafts, draftsRef, setActiveDraftId, setFocusRequest],
  );

  const chooseProjectFirst = useCallback(() => {
    if (projects.loaded && projects.projects.length === 1) {
      openDraft(projects.projects[0]!.id);
      return;
    }
    pickedProject.current = false;
    setProjectChoice(true);
  }, [openDraft, projects.loaded, projects.projects]);

  const setProjectPinned = useCallback(
    (id: string, pinned: boolean) =>
      client.connection.api.projects.setPinned({ id, pinned }).then(() => undefined),
    [client],
  );

  const loadBaseRefs = useCallback(
    (projectId: string, signal: AbortSignal) =>
      client.connection.api.projects.baseRefs({ id: projectId }, { signal }),
    [client],
  );

  const startInCurrentProject = useCallback(() => {
    if (currentProjectId === null) {
      setProjectChoice(true);
      return;
    }
    openDraft(currentProjectId);
  }, [currentProjectId, openDraft]);

  const direct = useMemo(
    () => ({
      bindings: config.keys.direct,
      onAction: (action: "new-task" | "new-task-in-project" | "new-task-no-project") => {
        if (action === "new-task") chooseProjectFirst();
        else if (action === "new-task-in-project") startInCurrentProject();
        else openDraft(null);
      },
    }),
    [chooseProjectFirst, config.keys.direct, openDraft, startInCurrentProject],
  );

  const selectTask = useCallback(
    (id: string) => {
      hideDraft();
      setProjectChoice(false);
      setNotice(undefined);
      onSelectTask(id);
    },
    [hideDraft, onSelectTask],
  );

  const createTask = useCallback(
    (input: CreateTaskInput) => {
      const submitted = activeDraft;
      if (submitted === undefined) return;
      setCreatingKeys((pending) => [...pending, submitted.key]);
      setCreateErrors((errors) => withoutError(errors, submitted.key));
      void client.connection.api.tasks
        .create(input)
        .then((task) => {
          // A create for the discarded draft's project sends that text, so its Undo must go:
          // restoring the draft would offer a second Send of the same task.
          setNotice((current) =>
            current !== undefined &&
            discardUndo.current?.notice === current &&
            discardUndo.current.projectId === submitted.composer.projectId
              ? undefined
              : current,
          );
          const current = draftsRef.current.find((entry) => entry.id === submitted.id);
          // Only the draft that sent this create may close, and only while it is untouched: a
          // draft opened or edited after the submit keeps its text and its selection.
          if (current?.key !== submitted.key || current.composer !== submitted.composer) return;
          // The create clears the draft that sent it and no other; its tab is replaced by the
          // task's working area in the same place.
          changeDrafts((all) => all.filter((entry) => entry.key !== submitted.key));
          if (activeDraftIdRef.current !== submitted.id) return;
          selectTask(task.id);
        })
        .catch((error: unknown) => {
          const message = describeLaunchError(error) ?? describeError(error);
          const current = draftsRef.current.find((entry) => entry.id === submitted.id);
          // A refusal for a draft that is gone or replaced still reaches the shell's notice.
          if (current?.key === submitted.key) {
            setCreateErrors((errors) => new Map(errors).set(submitted.key, message));
          } else {
            setNotice({ message, tone: "error" });
          }
        })
        .finally(() => {
          setCreatingKeys((pending) => pending.filter((key) => key !== submitted.key));
        });
    },
    [
      activeDraft,
      changeDrafts,
      client,
      draftsRef,
      selectTask,
      setCreateErrors,
      setCreatingKeys,
      setNotice,
    ],
  );

  const selectedTask =
    selectedRow === undefined ? undefined : tasks.tasks.find((task) => task.id === selectedRow.id);
  // The server owns `seenAt`, so opening a task or watching its status change clears the same
  // completion on every client. One mark per task/seenAt/status update: the next watched task
  // carries the new time, and a refused mark is retried on the next selection or status change.
  const selectedStatus = primaryTaskStatus(
    selectedTask ?? { primarySessionId: null },
    sessions.sessions,
  )?.status;
  const seenRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active || selectedTask === undefined || !hasUnseen(selectedTask, selectedStatus)) return;
    const key = [selectedTask.id, selectedTask.seenAt ?? "never", selectedStatus?.updatedAt].join(
      ":",
    );
    if (seenRequest.current === key) return;
    seenRequest.current = key;
    client.connection.api.tasks.markSeen({ id: selectedTask.id }).catch(() => {
      seenRequest.current = undefined;
    });
  }, [active, client, selectedStatus, selectedTask]);
  const selectedProject =
    selectedTask?.projectId === null || selectedTask === undefined
      ? undefined
      : projects.projects.find((project) => project.id === selectedTask.projectId);
  const taskWorkspace = useTaskWorkspace({
    client,
    task: selectedTask,
    sessions: sessions.sessions,
    terminals: terminals.terminals,
    config,
    profiles,
    drivers: chatCapabilities.drivers,
    capabilitiesReady: chatCapabilities.loaded,
    projectPath: selectedProject?.path,
    position: appearance.tabPosition,
    active,
  });
  const closeBinding = bindingOf(config, "close-tab");
  // A draft tab has the same keyboard close and numbered chords as any other tab; it has no
  // closed stack to reopen.
  const draftPrefix = useMemo(() => {
    const bindings: Record<string, string> = {};
    if (closeBinding !== null) bindings[closeBinding] = "close-draft";
    for (const [index, action] of NUMBER_ACTIONS.entries()) {
      const chord = bindingOf(config, action);
      if (chord !== null) bindings[chord] = `draft-${index + 1}`;
    }
    return {
      bindings,
      onAction: (action: string) => {
        if (action === "close-draft") {
          if (activeDraft !== undefined) discardDraft(activeDraft.id);
          return;
        }
        if (!action.startsWith("draft-")) return;
        const draft = drafts[Number(action.slice("draft-".length)) - 1];
        if (draft !== undefined) selectDraft(draft.id);
      },
    };
  }, [activeDraft, closeBinding, config, discardDraft, drafts, selectDraft]);
  // A draft is a tab in the main group; every open draft shows in the same strip. The project is
  // the visible label, so two drafts never read the same, and the pencil glyph says it is a draft
  // (`docs/layout.md`).
  const draftItems: VisualTabItem[] = drafts.map((entry, index) => {
    const projectName =
      entry.composer.projectId === null
        ? "No project"
        : (projects.projects.find((project) => project.id === entry.composer.projectId)?.name ??
          "Project unavailable");
    return {
      id: entry.id,
      kind: "draft",
      number: index < 9 ? index + 1 : undefined,
      label: projectName,
      ariaLabel: ["New task", projectName].join(" "),
      title: `New task · ${projectName}`,
      selected: entry.id === activeDraft?.id,
      canClose: true,
      paneId: DRAFT_PANE_ID,
    };
  });
  const draftStrip = (
    <VisualTabStrip
      label="New task"
      items={draftItems}
      position={appearance.tabPosition}
      onSelect={selectDraft}
      onClose={discardDraft}
    />
  );

  // A refused write gets one sentence: the draft still works here, but it will not survive a
  // reload. A notice about the current action keeps the slot.
  const storageNotice: VisualShellNotice | undefined =
    storageFailed && !storageNoticeDismissed
      ? { message: DRAFT_STORAGE_NOTICE, tone: "error" }
      : undefined;
  const shownNotice = notice ?? storageNotice;

  return (
    <>
      <VisualShellView
        rows={rows}
        settledRows={settledRows}
        selectedId={selectedTaskId}
        projectsLoaded={projects.loaded}
        hasProjects={projects.projects.length > 0}
        tasksLoaded={tasks.loaded}
        failure={
          failure === undefined ? undefined : `${failure.label}: ${describeError(failure.error)}`
        }
        shortcut={shortcut}
        newTaskShortcut={newTaskShortcut}
        findTaskShortcut={findTaskShortcut}
        settingsShortcut={settingsShortcut}
        renameShortcut={renameShortcut}
        removeShortcut={removeShortcut}
        focusSidebarShortcut={focusSidebarShortcut}
        settleShortcut={settleShortcut}
        taskActions={taskActions}
        rowFocus={listFocus}
        notice={shownNotice}
        onDismissNotice={() => {
          // Only dismissing the storage sentence silences it; dismissing a copy or action notice
          // must leave a later write failure reportable.
          if (shownNotice === storageNotice) setStorageNoticeDismissed(true);
          setNotice(undefined);
        }}
        addProjectShortcut={addProjectShortcut}
        direct={direct}
        onSelectTask={selectTask}
        onAddProject={() => setAddingProject(true)}
        onNewTask={chooseProjectFirst}
        onFindTask={() => setFinding(true)}
        onOpenSettings={onOpenSettings}
        composerOpen={activeDraft !== undefined}
        main={
          activeDraft !== undefined ? (
            <>
              <VisualTabPanel id={DRAFT_PANE_ID} labelledBy={`tab-${activeDraft.id}`} fill>
                <div className="visual-draft-pane">
                  <TaskComposer
                    key={activeDraft.id}
                    projects={projects.projects}
                    config={config}
                    configProblems={configProblems}
                    profiles={profiles}
                    chatDrivers={chatCapabilities.drivers.map((driver) => driver.kind)}
                    capabilitiesReady={chatCapabilities.loaded}
                    draft={activeDraft.composer}
                    onDraftChange={updateDraft}
                    onCreate={createTask}
                    onCancel={hideDraft}
                    onSetPinned={setProjectPinned}
                    loadBaseRefs={loadBaseRefs}
                    focusRequest={focusRequest}
                    onModalChange={setComposerModal}
                    creating={creating}
                    failure={createError}
                  />
                </div>
              </VisualTabPanel>
              {appearance.tabPosition === "bottom" && draftStrip}
            </>
          ) : selectedTask === undefined ? undefined : (
            taskWorkspace.main
          )
        }
        taskHeader={
          activeDraft === undefined && selectedTask !== undefined && selectedRow !== undefined ? (
            <TaskMain row={selectedRow} compact />
          ) : undefined
        }
        workingNotice={
          activeDraft === undefined && selectedTask !== undefined ? taskWorkspace.notice : undefined
        }
        chrome={
          activeDraft !== undefined
            ? appearance.tabPosition === "top"
              ? draftStrip
              : undefined
            : selectedTask !== undefined
              ? taskWorkspace.chrome
              : undefined
        }
        companion={
          activeDraft === undefined && selectedTask !== undefined
            ? taskWorkspace.companion
            : undefined
        }
        mainFill={activeDraft !== undefined || selectedTask !== undefined}
        prefixExtra={
          activeDraft !== undefined
            ? draftPrefix
            : selectedTask !== undefined
              ? taskWorkspace.prefix
              : undefined
        }
        prefixEnabled={
          active &&
          !addingProject &&
          !projectChoice &&
          !finding &&
          !composerModal &&
          !creating &&
          rename === undefined &&
          remove === undefined &&
          source === undefined &&
          !connectionOpen &&
          !configProblemsOpen &&
          taskWorkspace.prefixEnabled
        }
        status={{
          connection,
          onOpenConnection: (opener) => {
            dialogFocus?.remember(opener);
            setConnectionOpen(true);
          },
          onRetryConnection: () => client.recover(),
          onOpenConfigProblems: (opener) => {
            dialogFocus?.remember(opener);
            setConfigProblemsOpen(true);
          },
        }}
      />
      {taskWorkspace.dialogs}
      {finding && (
        <FindTaskDialog
          projects={projects.projects}
          tasks={tasks.tasks}
          onOpen={(task) => selectTask(task.id)}
          onClose={() => setFinding(false)}
        />
      )}
      {addingProject && (
        <AddProjectDialog
          onBrowse={browse}
          onAdd={async (path) => {
            await client.connection.api.projects.add({ path });
          }}
          onClose={() => setAddingProject(false)}
        />
      )}
      {projectChoice && (
        <ProjectChoiceDialog
          projects={projects.projects}
          onChoose={openDraft}
          onSetPinned={setProjectPinned}
          // A chosen project hands the keyboard to the prompt, which the composer focuses on mount;
          // `false` tells the dialog not to restore its opener on top of it. A cancelled picker
          // keeps the dialog's default (`null`), which returns to the New task button.
          finalFocus={() => (pickedProject.current ? false : null)}
          onClose={() => setProjectChoice(false)}
        />
      )}
      {rename !== undefined && (
        <RenameDialog
          target={rename}
          onSave={(name) => saveRename(rename, name)}
          onClose={() => setRename(undefined)}
        />
      )}
      {remove !== undefined && (
        <RemoveTaskDialog
          task={remove.task}
          workspaceMissing={remove.workspaceMissing}
          loadLiveBranch={
            remove.task.ownsWorktree
              ? () =>
                  createChangesActions(client, remove.task.id)
                    .finish()
                    .then((finish) => finish.branch)
              : undefined
          }
          finalFocus={() => {
            if (!removeSucceeded.current)
              return listFocus.current?.rowElement(remove.task.id) ?? null;
            // A removal that was not current must not move the keyboard off the current row.
            const id =
              removeCurrent.current === remove.task.id ? removeNext.current : removeCurrent.current;
            return id === undefined ? null : (listFocus.current?.rowElement(id) ?? null);
          }}
          onRemove={(force) => removeTask(remove.task, force)}
          onClose={closeRemove}
        />
      )}
      {source !== undefined && source.source !== undefined && (
        <TaskSourceDialog
          source={source.source}
          taskTitle={source.title}
          onClose={() => setSource(undefined)}
        />
      )}
      {connectionOpen && <ConnectionRecoveryDialog onClose={() => setConnectionOpen(false)} />}
      {configProblemsOpen && <ConfigProblemsDialog onClose={() => setConfigProblemsOpen(false)} />}
    </>
  );
}
