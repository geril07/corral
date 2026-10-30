import type { TerminalInfo } from "@corral/protocol/rpc";

export function terminalLabel(terminal: TerminalInfo): string {
  const program = terminal.command.split("/").pop() || terminal.command;
  const folder = terminal.cwd.replace(/\/+$/, "").split("/").pop() || "/";
  return `${program} · ${folder}`;
}

interface TerminalListProps {
  terminals: readonly TerminalInfo[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
}

export function TerminalList({
  terminals,
  activeId,
  onSelect,
  onClose,
  onCreate,
}: TerminalListProps) {
  return (
    <nav
      className="terminal-list"
      aria-label="terminals"
      // Clicking must not take keyboard focus away from the terminal.
      onMouseDown={(event) => event.preventDefault()}
    >
      <ul>
        {terminals.map((terminal) => (
          <li key={terminal.id} className={terminal.exit ? "exited" : undefined}>
            <button
              type="button"
              className="select"
              aria-current={terminal.id === activeId ? "true" : undefined}
              onClick={() => onSelect(terminal.id)}
            >
              {terminalLabel(terminal)}
              {terminal.exit && <span className="badge"> exited ({terminal.exit.exitCode})</span>}
            </button>
            <button
              type="button"
              className="close"
              aria-label={`close ${terminalLabel(terminal)}`}
              onClick={() => onClose(terminal.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="create" onClick={onCreate}>
        New terminal
      </button>
    </nav>
  );
}
