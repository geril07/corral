import type { CorralClient } from "@corral/client/corral-client";
import type { TerminalStreamState } from "@corral/client/terminal-stream";
import type { TerminalInfo, TerminalSize } from "@corral/protocol/rpc";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
// oxlint-disable-next-line import/no-unassigned-import -- xterm's own stylesheet
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  autoFocus?: boolean | undefined;
  /** Appended to the notice shown once the process has exited. */
  exitHint?: string | undefined;
}

/**
 * The terminal paints the surface it is drawn on, never a colour of its own: the card the pane sits
 * in decides it, so a terminal and a chat compose the same card.
 */
function readTerminalTheme(host: HTMLElement | null) {
  const surface = host?.closest<HTMLElement>(".visual-workspace-group") ?? document.body;
  const styles = getComputedStyle(surface);
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

/**
 * The two chords xterm keeps for the shell: Control+C is its interrupt and Control+V a
 * literal-next, so a selection could never be copied and the clipboard never reached the process.
 * Letting the browser have them runs xterm's own handlers, which answer the copy with the
 * selection and send the paste in the bracketed mode the program asked for. Copy needs a
 * selection; without one Control+C stays the interrupt. `code` is the physical key, so a
 * non-Latin layout still copies and pastes.
 */
function clipboardChord(event: KeyboardEvent, hasSelection: boolean): boolean {
  if (event.type !== "keydown" || event.altKey || event.shiftKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.code === "KeyV" || (event.code === "KeyC" && hasSelection);
}

/** One xterm.js bound to one server terminal. Output goes stream to xterm, never through React. */
export function TerminalView({
  client,
  terminal,
  onFit,
  exitHint,
  autoFocus = true,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const focusOnMount = useRef(autoFocus);
  const [streamState, setStreamState] = useState<TerminalStreamState>({
    status: "connecting",
    attempt: 1,
    startedAt: 0,
  });
  // The banner above the work area already reports a lost server; this pane speaks only for its
  // own stream, so a server outage does not produce a second notice.
  const appConnected =
    useSyncExternalStore(client.connection.state.subscribe, client.connection.state.getSnapshot)
      .status === "connected";
  const terminalId = terminal.id;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const xterm = new Terminal({
      // The server's snapshots carry about this much scrollback.
      scrollback: 5000,
      // A steady block: the caret marks the input position, it is not an animation of its own.
      cursorStyle: "block",
      cursorBlink: false,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
        "monospace",
      fontSize: 14,
      theme: readTerminalTheme(host),
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
    const unpublish = publishScreenText(xterm, host);

    const stream = client.attach(terminalId, xterm, {
      // The connected state arrives before the replay snapshot, which resets the canvas to the
      // shared grid. Fit after that replay so the local grid is not overwritten by it.
      onSnapshot: () => {
        if (document.visibilityState === "visible") proposeSize();
      },
    });
    xterm.attachCustomKeyEventHandler((event) => !clipboardChord(event, xterm.hasSelection()));
    xterm.onData((data) => stream.input(data));
    // Legacy mouse reports arrive as a binary string: one byte per character.
    xterm.onBinary((data) => stream.input(Uint8Array.from(data, (char) => char.charCodeAt(0))));

    // The terminal fits this box locally; the server's grid stays authoritative for every
    // attachment. A window that is still being laid out (or dragged) walks through a chain of
    // sizes, and resizing the shell for each of them reflows the restored screen for nothing, so
    // only a size that holds for a frame is proposed.
    let frame = 0;
    let held = "";
    const applySize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0 || host.closest("[inert]")) return;
      const size = fit.proposeDimensions();
      if (!size || !(size.cols > 0 && size.rows > 0)) return;
      // The server's snapshot may have put another client's grid on this canvas. Fit this pane
      // first, then ask the shared grid to follow it; the echo updates every attachment.
      fit.fit();
      stream.resize(size);
      onFit(size);
    };
    const proposeSize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0 || host.closest("[inert]")) return;
      const size = `${host.clientWidth}x${host.clientHeight}`;
      cancelAnimationFrame(frame);
      if (size === held) {
        applySize();
        return;
      }
      held = size;
      frame = requestAnimationFrame(() => proposeSize());
    };
    // A fresh attachment or reconnect starts on the server's grid, which may be another client's
    // size. The snapshot callback above re-proposes after the replay; a hidden or background
    // client leaves the shared grid alone until a `visibilitychange` to visible. Focus is
    // attributed to this host, not a document-level `focus`, so a window that regains focus
    // refits only the terminal that got the keyboard. Mount focuses xterm through this same host
    // path, and a page that opens unfocused still fits through the observer below.
    const unsubscribe = stream.state.subscribe(() => setStreamState(stream.state.getSnapshot()));
    const observer = new ResizeObserver(proposeSize);
    observer.observe(host);
    const refitOnFocus = () => proposeSize();
    const refitOnVisible = () => {
      if (document.visibilityState === "visible") proposeSize();
    };
    host.addEventListener("focusin", refitOnFocus);
    document.addEventListener("visibilitychange", refitOnVisible);
    proposeSize();
    if (focusOnMount.current) xterm.focus();

    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("focusin", refitOnFocus);
      document.removeEventListener("visibilitychange", refitOnVisible);
      observer.disconnect();
      unsubscribe();
      stream.close();
      unpublish();
      xterm.dispose();
    };
  }, [client, terminalId, onFit]);

  return (
    <section className="absolute inset-0 flex flex-col p-2" aria-label="active terminal">
      {/* The 8 px frame sits on the tab area, so xterm fits the padded box. */}
      <div className="terminal-host min-h-0 flex-1 overflow-hidden" ref={hostRef} />
      <TerminalNotice
        terminal={terminal}
        streamState={streamState}
        exitHint={exitHint}
        appConnected={appConnected}
      />
    </section>
  );
}

function TerminalNotice({
  terminal,
  streamState,
  exitHint,
  appConnected,
}: {
  terminal: TerminalInfo;
  streamState: TerminalStreamState;
  exitHint: string | undefined;
  appConnected: boolean;
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
    if (!appConnected) return null;
    return (
      <Alert role="status" aria-label="terminal connection">
        <AlertDescription>Connection lost. Reconnecting…</AlertDescription>
      </Alert>
    );
  }
  if (streamState.status === "capability-refused") {
    return (
      <Alert role="status" aria-label="terminal connection">
        <AlertDescription>
          The server refused this terminal's capability. Reconnect with the connection status to
          reattach it.
        </AlertDescription>
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
