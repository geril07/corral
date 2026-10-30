import type { CorralClient } from "@corral/client/corral-client";
import type { TerminalStreamState } from "@corral/client/terminal-stream";
import type { TerminalInfo, TerminalSize } from "@corral/protocol/rpc";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { publishScreenText } from "./screen-text-hook.ts";

/** The element xterm.js takes keystrokes on, for returning focus to the terminal after a dialog. */
export function terminalInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".terminal-host .xterm-helper-textarea");
}

const THEME = { background: "#0d1117", foreground: "#d6dde6", cursor: "#d6dde6" };

interface TerminalViewProps {
  client: CorralClient;
  terminal: TerminalInfo;
  onFit: (size: TerminalSize) => void;
  /** Appended to the notice shown once the process has exited. */
  exitHint?: string | undefined;
}

/** One xterm.js bound to one server terminal. Output goes stream to xterm, never through React. */
export function TerminalView({ client, terminal, onFit, exitHint }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [streamState, setStreamState] = useState<TerminalStreamState>({ status: "connecting" });
  const terminalId = terminal.id;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const xterm = new Terminal({
      // The server's snapshots carry about this much scrollback.
      scrollback: 5000,
      cursorBlink: true,
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      fontSize: 14,
      theme: THEME,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      xterm.loadAddon(webgl);
    } catch {
      // No WebGL here: xterm.js keeps its DOM renderer.
    }
    const unpublish = publishScreenText(xterm);

    const stream = client.attach(terminalId, xterm);
    const unsubscribe = stream.state.subscribe(() => setStreamState(stream.state.getSnapshot()));
    xterm.onData((data) => stream.input(data));
    // Legacy mouse reports arrive as a binary string: one byte per character.
    xterm.onBinary((data) => stream.input(Uint8Array.from(data, (char) => char.charCodeAt(0))));

    // The terminal follows the server's size; the container only proposes one.
    const proposeSize = () => {
      const size = fit.proposeDimensions();
      if (!size || !(size.cols > 0 && size.rows > 0)) return;
      stream.resize(size);
      onFit(size);
    };
    const observer = new ResizeObserver(proposeSize);
    observer.observe(host);
    proposeSize();
    xterm.focus();

    return () => {
      observer.disconnect();
      unsubscribe();
      stream.close();
      unpublish();
      xterm.dispose();
    };
  }, [client, terminalId, onFit]);

  return (
    <section className="terminal-view" aria-label="active terminal">
      <div className="terminal-host" ref={hostRef} />
      <TerminalNotice terminal={terminal} streamState={streamState} exitHint={exitHint} />
    </section>
  );
}

function TerminalNotice({
  terminal,
  streamState,
  exitHint,
}: {
  terminal: TerminalInfo;
  streamState: TerminalStreamState;
  exitHint: string | undefined;
}) {
  if (terminal.exit) {
    const { exitCode, signal } = terminal.exit;
    return (
      <p className="terminal-notice" role="status" aria-label="terminal exited">
        Process exited with {signal ? `signal ${signal}` : `code ${exitCode}`}.
        {exitHint && ` ${exitHint}`}
      </p>
    );
  }
  if (streamState.status === "disconnected") {
    return (
      <p className="terminal-notice" role="status" aria-label="terminal connection">
        Connection lost. Reconnecting…
      </p>
    );
  }
  if (streamState.status === "not-found") {
    return (
      <p className="terminal-notice" role="status" aria-label="terminal connection">
        The server no longer has this terminal.
      </p>
    );
  }
  return null;
}
