import type { CorralClient } from "@corral/client/corral-client";
import type { TerminalStreamState } from "@corral/client/terminal-stream";
import type { TerminalInfo, TerminalSize } from "@corral/protocol/rpc";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
// oxlint-disable-next-line import/no-unassigned-import -- xterm's own stylesheet
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../common/ui/index.ts";
import { publishScreenText } from "./screen-text-hook.ts";

/** The element xterm.js takes keystrokes on, for returning focus to the terminal after a dialog. */
export function terminalInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".terminal-host .xterm-helper-textarea");
}

interface TerminalViewProps {
  client: CorralClient;
  terminal: TerminalInfo;
  onFit: (size: TerminalSize) => void;
  /** Appended to the notice shown once the process has exited. */
  exitHint?: string | undefined;
}

function readTerminalTheme() {
  const styles = getComputedStyle(document.body);
  // xterm's parser does not accept OKLCH; canvas resolves the stock CSS colors to sRGB.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return {};
  const color = (value: string) => {
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${red}, ${green}, ${blue})`;
  };
  return {
    background: color(styles.backgroundColor),
    foreground: color(styles.color),
    cursor: color(styles.color),
  };
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
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
        "monospace",
      fontSize: 14,
      theme: readTerminalTheme(),
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
    <section className="absolute inset-0 flex flex-col" aria-label="active terminal">
      <div className="terminal-host min-h-0 flex-1 overflow-hidden p-2" ref={hostRef} />
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
      <Alert role="status" aria-label="terminal exited">
        <AlertDescription>
          Process exited with {signal ? `signal ${signal}` : `code ${exitCode}`}.
          {exitHint && ` ${exitHint}`}
        </AlertDescription>
      </Alert>
    );
  }
  if (streamState.status === "disconnected") {
    return (
      <Alert role="status" aria-label="terminal connection">
        <AlertDescription>Connection lost. Reconnecting…</AlertDescription>
      </Alert>
    );
  }
  if (streamState.status === "not-found") {
    return (
      <Alert role="status" aria-label="terminal connection">
        <AlertDescription>The server no longer has this terminal.</AlertDescription>
      </Alert>
    );
  }
  return null;
}
