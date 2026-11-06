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
  const [streamState, setStreamState] = useState<TerminalStreamState>({
    status: "connecting",
    attempt: 1,
    startedAt: 0,
  });
  const terminalId = terminal.id;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    // The cursor is the terminal's only motion. Reduced motion leaves it steady and visible.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const xterm = new Terminal({
      // The server's snapshots carry about this much scrollback.
      scrollback: 5000,
      cursorBlink: !reducedMotion.matches,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
        "monospace",
      fontSize: 14,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const onMotionChange = () => {
      xterm.options.cursorBlink = !reducedMotion.matches;
    };
    reducedMotion.addEventListener("change", onMotionChange);
    xterm.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      xterm.loadAddon(webgl);
    } catch {
      // No WebGL here: xterm.js keeps its DOM renderer.
    }
    const unpublish = publishScreenText(xterm);

    const stream = client.attach(terminalId, xterm, {
      // The connected state arrives before the replay snapshot, which resets the canvas to the
      // shared grid. Fit after that replay so the local grid is not overwritten by it.
      onSnapshot: () => {
        if (document.visibilityState === "visible") proposeSize();
      },
    });
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
      const size = fit.proposeDimensions();
      if (!size || !(size.cols > 0 && size.rows > 0)) return;
      // The server's snapshot may have put another client's grid on this canvas. Fit this pane
      // first, then ask the shared grid to follow it; the echo updates every attachment.
      fit.fit();
      stream.resize(size);
      onFit(size);
    };
    const proposeSize = () => {
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
    xterm.focus();

    return () => {
      reducedMotion.removeEventListener("change", onMotionChange);
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
      {/* The 8 px frame sits on the tab area, so xterm fits the padded box (`layout.md`, **Terminal**). */}
      <div className="terminal-host min-h-0 flex-1 overflow-hidden" ref={hostRef} />
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
