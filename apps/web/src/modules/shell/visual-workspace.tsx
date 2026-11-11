import { describeError } from "@corral/client/rpc-errors";
import { activeAfterClose } from "@corral/client/terminal-selection";
import { taskSettingsFor } from "@corral/protocol/config";
import type { CreateTaskInput, Task } from "@corral/protocol/rpc";
import { workspaceMissingPath } from "@corral/protocol/workspace";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNow } from "../../common/hooks/use-now.ts";
import { createChangesActions } from "../changes/index.ts";
import { useCorralClient } from "../connection/index.ts";
import { bindingOf, useConfig } from "../keymap/index.ts";
import { AddProjectDialog, ProjectChoiceDialog } from "../projects/index.ts";
import { defaultLaunch, describeLaunchError } from "../sessions/index.ts";
import {
  emptyTaskComposerDraft,
  RemoveTaskDialog,
  switchComposerProject,
  TaskComposer,
  TaskSourceDialog,
  workspaceGoneNotice,
  type TaskComposerDraft,
} from "../tasks/index.ts";
import { RenameDialog, type RenameTarget } from "../workspace/index.ts";
import {
  VisualShellView,
  type VisualRowFocus,
  type VisualShellNotice,
  type VisualTaskActions,
} from "./visual-view.tsx";
import { buildTaskRows } from "./visual-status.ts";

/** The open removal and its preflight answer. */
interface RemoveState {
  task: Task;
  workspaceMissing: boolean;
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
  const { config, profiles, loaded: configLoaded } = useConfig();
  const now = useNow(30_000);
  const projects = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const tasks = useSyncExternalStore(client.tasks.subscribe, client.tasks.getSnapshot);
  const sessions = useSyncExternalStore(client.sessions.subscribe, client.sessions.getSnapshot);
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
  // Whether the open project choice ended in a draft. The picker is replaced by the composer in one
  // commit, so the dialog's final-focus callback reads this ref instead of the render it closed in.
  const pickedProject = useRef(false);
  const [draft, setDraft] = useState<TaskComposerDraft>();
  const [focusRequest, setFocusRequest] = useState(0);
  const [composerModal, setComposerModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [rename, setRename] = useState<RenameTarget>();
  const [remove, setRemove] = useState<RemoveState>();
  const [source, setSource] = useState<Task>();
  const [notice, setNotice] = useState<VisualShellNotice>();
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
  const selectedRow =
    selectedTaskId === null
      ? undefined
      : (rows.find((row) => row.id === selectedTaskId) ?? rows[0]);
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
  const prefix = config.keys.prefix;
  const shortcut = useMemo(
    () => (binding === null ? undefined : { prefix, binding }),
    [binding, prefix],
  );
  const newTaskShortcut = useMemo(
    () => (newTaskBinding === null ? undefined : { prefix, binding: newTaskBinding }),
    [newTaskBinding, prefix],
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
        rows.map((row) => row.id),
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
    [client, onSelectTask, rows, selectedRow],
  );

  const startDraft = useCallback(
    (projectId: string | null) => {
      const project =
        projectId === null
          ? undefined
          : projects.projects.find((candidate) => candidate.id === projectId);
      const settings = project === undefined ? config.tasks : taskSettingsFor(config, project.path);
      // Before the server's config arrives, the defaults may not name the real agent; leave the
      // draft unpinned so it follows the loaded config instead of freezing the placeholder.
      const opening = configLoaded ? defaultLaunch(settings, profiles, config.agents) : undefined;
      setDraft((previous) => {
        const next =
          previous === undefined
            ? emptyTaskComposerDraft(projectId)
            : switchComposerProject(previous, projectId);
        // Pin the launch the draft opened with. A later config edit then shows an invalidation
        // instead of silently swapping the runtime under the same prompt (`docs/ux.md`).
        return { ...next, agent: next.agent ?? opening };
      });
      pickedProject.current = true;
      setProjectChoice(false);
      setCreateError(undefined);
      setFocusRequest((request) => request + 1);
    },
    [config, configLoaded, profiles, projects.projects],
  );

  const chooseProjectFirst = useCallback(() => {
    if (projects.loaded && projects.projects.length === 1) {
      startDraft(projects.projects[0]!.id);
      return;
    }
    pickedProject.current = false;
    setProjectChoice(true);
  }, [projects.loaded, projects.projects, startDraft]);

  const setProjectPinned = useCallback(
    (id: string, pinned: boolean) =>
      client.connection.api.projects.setPinned({ id, pinned }).then(() => undefined),
    [client],
  );

  const loadBranches = useCallback(
    (projectId: string, signal: AbortSignal) =>
      client.connection.api.projects.branches({ id: projectId }, { signal }),
    [client],
  );

  const startInCurrentProject = useCallback(() => {
    if (currentProjectId === null) {
      setProjectChoice(true);
      return;
    }
    startDraft(currentProjectId);
  }, [currentProjectId, startDraft]);

  const direct = useMemo(
    () => ({
      bindings: config.keys.direct,
      onAction: (action: "new-task" | "new-task-in-project" | "new-task-no-project") => {
        if (action === "new-task") chooseProjectFirst();
        else if (action === "new-task-in-project") startInCurrentProject();
        else startDraft(null);
      },
    }),
    [chooseProjectFirst, config.keys.direct, startDraft, startInCurrentProject],
  );

  const selectTask = useCallback(
    (id: string) => {
      setDraft(undefined);
      setProjectChoice(false);
      setCreateError(undefined);
      setNotice(undefined);
      onSelectTask(id);
    },
    [onSelectTask],
  );

  const createTask = useCallback(
    (input: CreateTaskInput) => {
      setCreating(true);
      setCreateError(undefined);
      void client.connection.api.tasks
        .create(input)
        .then((task) => {
          setDraft(undefined);
          setCreateError(undefined);
          onSelectTask(task.id);
        })
        .catch((error: unknown) => {
          setCreateError(describeLaunchError(error) ?? describeError(error));
        })
        .finally(() => setCreating(false));
    },
    [client, onSelectTask],
  );

  return (
    <>
      <VisualShellView
        rows={rows}
        selectedId={selectedTaskId}
        projectsLoaded={projects.loaded}
        hasProjects={projects.projects.length > 0}
        tasksLoaded={tasks.loaded}
        failure={
          failure === undefined ? undefined : `${failure.label}: ${describeError(failure.error)}`
        }
        shortcut={shortcut}
        newTaskShortcut={newTaskShortcut}
        settingsShortcut={settingsShortcut}
        renameShortcut={renameShortcut}
        removeShortcut={removeShortcut}
        taskActions={taskActions}
        rowFocus={listFocus}
        notice={notice}
        onDismissNotice={() => setNotice(undefined)}
        direct={direct}
        onSelectTask={selectTask}
        onAddProject={() => setAddingProject(true)}
        onNewTask={chooseProjectFirst}
        onOpenSettings={onOpenSettings}
        composerOpen={draft !== undefined}
        main={
          draft === undefined ? undefined : (
            <TaskComposer
              projects={projects.projects}
              config={config}
              profiles={profiles}
              chatDrivers={chatCapabilities.drivers.map((driver) => driver.kind)}
              capabilitiesReady={chatCapabilities.loaded}
              draft={draft}
              onDraftChange={setDraft}
              onCreate={createTask}
              onCancel={() => setDraft(undefined)}
              onSetPinned={setProjectPinned}
              loadBranches={loadBranches}
              focusRequest={focusRequest}
              onModalChange={setComposerModal}
              creating={creating}
              failure={createError}
            />
          )
        }
        prefixEnabled={
          active &&
          !addingProject &&
          !projectChoice &&
          !composerModal &&
          !creating &&
          rename === undefined &&
          remove === undefined &&
          source === undefined
        }
      />
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
          onChoose={startDraft}
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
    </>
  );
}
