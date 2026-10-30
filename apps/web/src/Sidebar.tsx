import type { Selection, TaskNode, WorkspaceTree } from "@corral/client/workspace-tree";
import type { Project, Task, TerminalInfo } from "@corral/protocol/rpc";
import { useState } from "react";

export function terminalLabel(terminal: TerminalInfo): string {
  const program = terminal.command.split("/").pop() || terminal.command;
  const folder = terminal.cwd.replace(/\/+$/, "").split("/").pop() || "/";
  return `${program} · ${folder}`;
}

interface SidebarProps {
  tree: WorkspaceTree;
  selection: Selection;
  onSelectProject: (project: Project) => void;
  onSelectTask: (task: Task) => void;
  onSelectLoose: () => void;
  onSelectTerminal: (terminal: TerminalInfo) => void;
  onCloseTerminal: (id: string) => void;
  onToggleArchive: (task: Task) => void;
  onRemoveTask: (task: Task) => void;
  onAddProject: () => void;
  onNewTask: () => void;
  onNewTerminal: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { tree, selection } = props;
  // Projects whose archived tasks the user opened; the group is also open while it holds the current task.
  const [openArchives, setOpenArchives] = useState<ReadonlySet<string>>(new Set());
  const toggleArchive = (projectId: string) =>
    setOpenArchives((open) => {
      const next = new Set(open);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });

  const terminalItem = (terminal: TerminalInfo) => (
    <li key={terminal.id} className={terminal.exit ? "exited" : undefined}>
      <div className="row">
        <button
          type="button"
          className="select"
          aria-current={terminal.id === selection.terminalId ? "true" : undefined}
          onClick={() => props.onSelectTerminal(terminal)}
        >
          {terminalLabel(terminal)}
          {terminal.exit && <span className="badge"> exited ({terminal.exit.exitCode})</span>}
        </button>
        <button
          type="button"
          className="icon danger"
          aria-label={`close ${terminalLabel(terminal)}`}
          onClick={() => props.onCloseTerminal(terminal.id)}
        >
          ×
        </button>
      </div>
    </li>
  );

  const taskItem = ({ task, terminals }: TaskNode) => (
    <li key={task.id} className={task.state === "archived" ? "archived" : undefined}>
      <div className="row">
        <button
          type="button"
          className="select"
          aria-current={task.id === selection.taskId ? "true" : undefined}
          onClick={() => props.onSelectTask(task)}
        >
          {task.title}
          <span className="branch"> {task.branch}</span>
        </button>
        <button
          type="button"
          className="icon"
          aria-label={`${task.state === "active" ? "archive" : "unarchive"} ${task.title}`}
          onClick={() => props.onToggleArchive(task)}
        >
          {task.state === "active" ? "▾" : "▴"}
        </button>
        <button
          type="button"
          className="icon danger"
          aria-label={`remove task ${task.title}`}
          onClick={() => props.onRemoveTask(task)}
        >
          ×
        </button>
      </div>
      {terminals.length > 0 && <ul>{terminals.map(terminalItem)}</ul>}
    </li>
  );

  return (
    <nav
      className="workspace"
      aria-label="workspace"
      // Clicking must not take keyboard focus away from the terminal.
      onMouseDown={(event) => event.preventDefault()}
    >
      <ul>
        {tree.projects.map(({ project, active, archived }) => {
          const holdsCurrent = archived.some(({ task }) => task.id === selection.taskId);
          const archiveOpen = holdsCurrent || openArchives.has(project.id);
          return (
            <li key={project.id}>
              <div className="row project" data-current={project.id === selection.projectId}>
                <button
                  type="button"
                  className="select"
                  onClick={() => props.onSelectProject(project)}
                >
                  {project.name}
                </button>
              </div>
              <ul>
                {active.map(taskItem)}
                {archived.length > 0 && (
                  <li>
                    <button
                      type="button"
                      className="archive-toggle"
                      aria-expanded={archiveOpen}
                      disabled={holdsCurrent}
                      onClick={() => toggleArchive(project.id)}
                    >
                      <span aria-hidden>{archiveOpen ? "▾" : "▸"} </span>
                      Archived ({archived.length})
                    </button>
                    {archiveOpen && <ul>{archived.map(taskItem)}</ul>}
                  </li>
                )}
              </ul>
            </li>
          );
        })}
        {tree.loose.length > 0 && (
          <li>
            <div className="row project" data-current={selection.taskId === null}>
              <button type="button" className="select" onClick={props.onSelectLoose}>
                No task
              </button>
            </div>
            <ul>{tree.loose.map(terminalItem)}</ul>
          </li>
        )}
      </ul>
      <div className="actions">
        <button type="button" onClick={props.onAddProject}>
          Add project
        </button>
        <button
          type="button"
          onClick={props.onNewTask}
          disabled={selection.projectId === undefined}
        >
          New task
        </button>
        <button type="button" onClick={props.onNewTerminal}>
          New terminal
        </button>
      </div>
    </nav>
  );
}
