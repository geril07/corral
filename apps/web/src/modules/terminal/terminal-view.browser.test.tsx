import type { CorralClient } from "@corral/client/corral-client";
import type { CreateSocket } from "@corral/client/reconnecting-socket";
import type { TerminalSurface } from "@corral/client/terminal-stream";
import type { TerminalSize } from "@corral/protocol/rpc";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { expect, test, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { realServerClients } from "../../../test/real-client.ts";
import { serverTarget } from "../../../test/server-url.ts";
import { TerminalView } from "./terminal-view.tsx";

const SIZE = { cols: 80, rows: 24 };
const { newClient } = realServerClients();

/** A fresh client connects on its own; its api calls reject until it has. */
async function connected(client: CorralClient) {
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
}

/**
 * The box one client's terminal lives in. The size is set before the terminal's own effect runs,
 * so its first fit is this box rather than the layout the test page happens to start with.
 */
function SizedPane({
  name,
  width,
  height,
  children,
}: {
  name: string;
  width: number;
  height: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
  }, [width, height]);
  return (
    <div className="relative" data-pane={name} ref={ref}>
      {children}
    </div>
  );
}

/** The size of the PTY, which is the grid every attached client shows (`design.md`, Open questions). */
async function serverSize(client: CorralClient, terminalId: string): Promise<TerminalSize> {
  const terminal = (await client.connection.api.terminals.list()).find(
    (each) => each.id === terminalId,
  );
  if (!terminal) throw new Error("the terminal is gone");
  return terminal.size;
}

function pane(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-pane="${name}"]`);
  if (!element) throw new Error(`the ${name} pane is not mounted`);
  return element;
}

/** The box the terminal fits itself into. */
function terminalHost(name: string): HTMLElement {
  const host = pane(name).querySelector<HTMLElement>(".terminal-host");
  if (!host) throw new Error(`the ${name} pane has no terminal host`);
  return host;
}

/** xterm's canvas box: it carries the shared grid's size, not the pane's. */
function canvas(name: string): HTMLElement {
  const screen = pane(name).querySelector<HTMLElement>(".xterm-screen");
  if (!screen) throw new Error(`the ${name} pane has no xterm screen`);
  return screen;
}

const widthOf = (element: HTMLElement) => element.getBoundingClientRect().width;

/** Gives a pane's box a size; the terminal fits to it through its ResizeObserver. */
function resizePane(name: string, width: number, height: number) {
  const element = pane(name);
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
}

/** The sizes a pane's terminal proposed, in order, as the view reports them through `onFit`. */
function fitCount(reports: Map<string, TerminalSize[]>, name: string): number {
  return reports.get(name)?.length ?? 0;
}

/** The size a pane's terminal proposed after `after`, i.e. once it fitted its box. */
function fitted(
  reports: Map<string, TerminalSize[]>,
  name: string,
  after: number,
): Promise<TerminalSize> {
  return vi.waitFor(() => {
    const list = reports.get(name);
    if (list === undefined || list.length <= after)
      throw new Error(`the ${name} terminal has not fitted its box`);
    return list[list.length - 1]!;
  });
}

test("a client that regains focus refits to its own pane, and the other keeps its canvas", async () => {
  const smallClient = newClient();
  const largeClient = newClient();
  await connected(smallClient);
  await connected(largeClient);
  const terminal = await smallClient.connection.api.terminals.create({
    command: "/bin/cat",
    size: SIZE,
  });
  const reports = new Map<string, TerminalSize[]>();
  const panes = [
    { name: "small", client: smallClient, width: 360, height: 240 },
    { name: "large", client: largeClient, width: 800, height: 420 },
  ];
  await render(
    <>
      {panes.map((each) => (
        <SizedPane key={each.name} name={each.name} width={each.width} height={each.height}>
          <TerminalView
            client={each.client}
            terminal={terminal}
            onFit={(size) => {
              reports.set(each.name, [...(reports.get(each.name) ?? []), size]);
            }}
          />
        </SizedPane>
      ))}
    </>,
  );

  // Each mounted client proposes its own box; the mounts are done once the PTY holds one of them.
  const smallFit = await fitted(reports, "small", 0);
  const largeAtMount = await fitted(reports, "large", 0);
  await vi.waitFor(async () => {
    const size = await serverSize(smallClient, terminal.id);
    if (![smallFit.cols, largeAtMount.cols].includes(size.cols))
      throw new Error(`the PTY has neither mounted grid: ${size.cols}x${size.rows}`);
  });

  // The larger client fits last: the PTY takes its grid, so the small client shows it clipped.
  // That is the defect the refit has to undo.
  const beforeLargeFit = fitCount(reports, "large");
  resizePane("large", 800, 460);
  const largeFit = await fitted(reports, "large", beforeLargeFit);
  expect(largeFit.cols).toBeGreaterThan(smallFit.cols);
  await vi.waitFor(async () =>
    expect(await serverSize(smallClient, terminal.id)).toEqual(largeFit),
  );
  await vi.waitFor(() =>
    expect(widthOf(canvas("small"))).toBeGreaterThan(widthOf(terminalHost("small"))),
  );
  const largeCanvas = canvas("large");
  const largeCanvasWidth = widthOf(largeCanvas);

  // Going back to the small client gives its terminal the keyboard. It re-proposes its own box,
  // so the server reports the small grid again and its canvas fits the pane.
  const input = terminalHost("small").querySelector<HTMLElement>(".xterm-helper-textarea");
  if (!input) throw new Error("the small terminal has no input");
  expect(document.activeElement).not.toBe(input);
  input.focus();
  expect(document.activeElement).toBe(input);

  await vi.waitFor(async () =>
    expect(await serverSize(smallClient, terminal.id)).toEqual(smallFit),
  );
  await vi.waitFor(() =>
    expect(widthOf(canvas("small"))).toBeLessThanOrEqual(widthOf(terminalHost("small"))),
  );

  // The other client is still attached to the same terminal: its canvas is the same element and
  // shrinks to the shared grid the small client just asked for, fitting its larger pane instead of
  // being clipped by it.
  expect(canvas("large")).toBe(largeCanvas);
  await vi.waitFor(() => expect(widthOf(largeCanvas)).toBeLessThan(largeCanvasWidth));
  expect(widthOf(largeCanvas)).toBeLessThanOrEqual(widthOf(terminalHost("large")));
});

test("a client whose page becomes visible again refits to its own pane", async () => {
  const client = newClient();
  const other = newClient();
  await connected(client);
  await connected(other);
  const terminal = await client.connection.api.terminals.create({
    command: "/bin/cat",
    size: SIZE,
  });
  const reports = new Map<string, TerminalSize[]>();
  await render(
    <SizedPane name="only" width={500} height={340}>
      <TerminalView
        client={client}
        terminal={terminal}
        onFit={(size) => {
          reports.set("only", [...(reports.get("only") ?? []), size]);
        }}
      />
    </SizedPane>,
  );

  const ownFit = await fitted(reports, "only", 0);
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(ownFit));
  const ownCanvas = widthOf(canvas("only"));

  // A second client fits the shared grid while this page is in the background.
  const background = other.attach(terminal.id, {
    write: (_data, callback) => callback?.(),
    reset: () => {},
    resize: () => {},
  });
  const awayFit = { cols: ownFit.cols + 20, rows: ownFit.rows + 5 };
  background.resize(awayFit);
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(awayFit));
  await vi.waitFor(() =>
    expect(widthOf(canvas("only"))).toBeGreaterThan(widthOf(terminalHost("only"))),
  );

  // A `visibilitychange` while the page is still hidden must not refit: its box is the stale one.
  // The host size has not changed, so a handler without the guard refits synchronously, and the
  // report is visible before the dispatch returns.
  const reportsWhileHidden = fitCount(reports, "only");
  const canvasWhileHidden = widthOf(canvas("only"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  try {
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fitCount(reports, "only")).toBe(reportsWhileHidden);
    expect(widthOf(canvas("only"))).toBe(canvasWhileHidden);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }

  // The page becomes visible again, as activating its tab does; the terminal re-proposes its own
  // box and gets its canvas back.
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(ownFit));
    await vi.waitFor(() => expect(widthOf(canvas("only"))).toBeCloseTo(ownCanvas, 0));
  } finally {
    background.close();
    Reflect.deleteProperty(document, "visibilityState");
  }
});

const idleSurface: TerminalSurface = {
  write: (_data, callback) => callback?.(),
  reset: () => {},
  resize: () => {},
};

/** Holds terminal sockets so a test can drop one without touching focus, visibility or layout. */
function trackTerminalSockets() {
  const sockets: WebSocket[] = [];
  const createSocket: CreateSocket = (url, protocols) => {
    const socket = new WebSocket(url, protocols);
    if (url.includes("/terminals/")) sockets.push(socket);
    return socket;
  };
  return { sockets, createSocket };
}

test("a terminal fits its pane when it proposes a size, before the server echoes it", async () => {
  const client = newClient();
  await connected(client);
  const terminal = await client.connection.api.terminals.create({
    command: "/bin/cat",
    size: SIZE,
  });
  const fits: { size: TerminalSize; host: number; canvas: number }[] = [];
  await render(
    <SizedPane name="fit" width={1640} height={979}>
      <TerminalView
        client={client}
        terminal={terminal}
        onFit={(size) => {
          fits.push({
            size,
            host: widthOf(terminalHost("fit")),
            canvas: widthOf(canvas("fit")),
          });
        }}
      />
    </SizedPane>,
  );

  // The first proposal is this pane's own grid. It must already be on the canvas: the server's
  // echo is a round-trip later, and a pane showing the old grid until then is the reported defect.
  const first = await vi.waitFor(() => {
    const report = fits[0];
    if (report === undefined) throw new Error("the terminal has not proposed a size");
    return report;
  });
  expect(first.size.cols).toBeGreaterThan(145);
  // xterm reserves the scrollbar's width; the canvas otherwise fills the host.
  expect(first.host - first.canvas).toBeLessThan(24);

  // The same holds when the host changes: the settled box reaches the canvas before the server's
  // echo, so a sidebar drag or window resize does not wait for a round-trip.
  const beforeResize = fits.length;
  resizePane("fit", 900, 500);
  const resized = await vi.waitFor(() => {
    const report = fits[beforeResize];
    if (report === undefined) throw new Error("the terminal has not fitted its new box");
    return report;
  });
  expect(resized.size.cols).toBeLessThan(first.size.cols);
  expect(resized.host - resized.canvas).toBeLessThan(24);
});

test("a reconnect re-fits this pane to its own size", async () => {
  const { sockets, createSocket } = trackTerminalSockets();
  const client = newClient(serverTarget(), createSocket);
  const other = newClient();
  await connected(client);
  await connected(other);
  const terminal = await client.connection.api.terminals.create({
    command: "/bin/cat",
    size: SIZE,
  });
  const reports = new Map<string, TerminalSize[]>();
  await render(
    <SizedPane name="reconnect" width={500} height={340}>
      <TerminalView
        client={client}
        terminal={terminal}
        onFit={(size) => {
          reports.set("reconnect", [...(reports.get("reconnect") ?? []), size]);
        }}
      />
    </SizedPane>,
  );

  const ownFit = await fitted(reports, "reconnect", 0);
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(ownFit));

  // Another client fits the shared PTY while this pane stays attached, focused and visible.
  const shared = other.attach(terminal.id, idleSurface);
  const awayFit = { cols: ownFit.cols + 20, rows: ownFit.rows + 5 };
  shared.resize(awayFit);
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(awayFit));
  await vi.waitFor(() =>
    expect(widthOf(canvas("reconnect"))).toBeGreaterThan(widthOf(terminalHost("reconnect"))),
  );

  // Let any fitting already in flight land before taking the baseline.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)));
  });

  // Drop only this terminal's socket. No test action focuses the pane, changes its visibility or
  // resizes it; the reattachment itself re-proposes this client's own grid.
  const before = fitCount(reports, "reconnect");
  const socketsBefore = sockets.length;
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error("the terminal has no socket");
  socket.close();
  await vi.waitFor(() => {
    if (sockets.length === socketsBefore) throw new Error("the terminal has not reattached");
  });
  await vi.waitFor(() => {
    const list = reports.get("reconnect") ?? [];
    if (list.length <= before) throw new Error("the terminal has not refitted after reattaching");
    const latest = list.at(-1);
    if (latest?.cols !== ownFit.cols || latest.rows !== ownFit.rows) {
      throw new Error(`the terminal refitted ${latest?.cols}x${latest?.rows}, not its own grid`);
    }
  });
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(ownFit));
  await vi.waitFor(() =>
    expect(widthOf(canvas("reconnect"))).toBeLessThanOrEqual(widthOf(terminalHost("reconnect"))),
  );

  // The shared grid stays authoritative: the other client can still set it, and this pane shows
  // the clipped grid until its next attach re-asserts its own.
  const sharedAgain = { cols: awayFit.cols + 10, rows: awayFit.rows + 2 };
  shared.resize(sharedAgain);
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(sharedAgain));
  await vi.waitFor(() =>
    expect(widthOf(canvas("reconnect"))).toBeGreaterThan(widthOf(terminalHost("reconnect"))),
  );
  shared.close();
});
