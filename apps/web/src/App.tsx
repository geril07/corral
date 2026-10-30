import type { CorralClient } from "@corral/client/corral-client";
import { createPrefixKeymap } from "@corral/client/prefix-keymap";
import { activeAfterClose, effectiveActive, stepActive } from "@corral/client/terminal-selection";
import type { TerminalSize } from "@corral/protocol/rpc";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet
import "./app.css";
import { ConnectionNotice } from "./ConnectionNotice.tsx";
import { usePrefixMode } from "./prefix-mode.ts";
import { TerminalList } from "./TerminalList.tsx";
import { TerminalView } from "./TerminalView.tsx";

type Action = "new-terminal" | "close-terminal" | "next-terminal" | "previous-terminal";

// Hardcoded until the config file (MVP step 5).
const BINDINGS: Readonly<Record<string, Action>> = {
  c: "new-terminal",
  x: "close-terminal",
  n: "next-terminal",
  p: "previous-terminal",
};

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

export function App({ client, prefix }: { client: CorralClient; prefix: string }) {
  const connection = useSyncExternalStore(
    client.connection.state.subscribe,
    client.connection.state.getSnapshot,
  );
  const { loaded, terminals } = useSyncExternalStore(
    client.terminals.subscribe,
    client.terminals.getSnapshot,
  );
  const [chosenId, setChosenId] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const fitSize = useRef(DEFAULT_SIZE);

  const ids = terminals.map((terminal) => terminal.id);
  const activeId = effectiveActive(ids, chosenId);
  const active = terminals.find((terminal) => terminal.id === activeId);

  const show = (id: string | undefined) => setChosenId(id);

  const attempt = async (work: () => Promise<void>) => {
    setFailure(undefined);
    try {
      await work();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };

  const createTerminal = () =>
    attempt(async () => {
      const created = await client.connection.api.terminals.create({ size: fitSize.current });
      show(created.id);
    });

  const closeTerminal = (id: string) =>
    attempt(async () => {
      if (id === activeId) show(activeAfterClose(ids, id));
      await client.connection.api.terminals.close({ id });
    });

  const keymap = useMemo(() => createPrefixKeymap(prefix, BINDINGS), [prefix]);
  const armed = usePrefixMode(keymap, (action: Action) => {
    if (action === "new-terminal") void createTerminal();
    else if (action === "close-terminal" && activeId) void closeTerminal(activeId);
    else if (action === "next-terminal") show(stepActive(ids, activeId, 1));
    else if (action === "previous-terminal") show(stepActive(ids, activeId, -1));
  });

  const rememberFitSize = useCallback((size: TerminalSize) => {
    fitSize.current = size;
  }, []);

  if (connection.status === "protocol-mismatch") {
    return <ConnectionNotice state={connection} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <TerminalList
          terminals={terminals}
          activeId={activeId}
          onSelect={show}
          onClose={(id) => void closeTerminal(id)}
          onCreate={() => void createTerminal()}
        />
        <footer>
          <ConnectionNotice state={connection} />
          {failure && (
            <p className="failure" role="alert">
              {failure}
            </p>
          )}
          {armed ? (
            <output aria-label="prefix mode">prefix: c new · x close · n next · p previous</output>
          ) : (
            <p className="hint">{prefix} then c / x / n / p</p>
          )}
        </footer>
      </aside>
      <main>
        {active ? (
          <TerminalView key={active.id} client={client} terminal={active} onFit={rememberFitSize} />
        ) : (
          loaded && <p className="empty">No terminals. Press {prefix}, then c.</p>
        )}
      </main>
    </div>
  );
}
