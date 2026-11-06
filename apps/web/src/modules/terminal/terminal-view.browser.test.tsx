import type { CorralClient } from "@corral/client/corral-client";
import type { CreateSocket } from "@corral/client/reconnecting-socket";
import type { TerminalSurface } from "@corral/client/terminal-stream";
import type { TerminalSize } from "@corral/protocol/rpc";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { realServerClients, screenText } from "../../../test/real-client.ts";
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

/** Holds the server's resize echoes until the test releases them. */
function holdResizeEchoes() {
  const snapshots: string[] = [];
  const held: (() => void)[] = [];
  let released = false;
  const createSocket: CreateSocket = (url, protocols) => {
    const socket = new WebSocket(url, protocols);
    if (!url.includes("/terminals/")) return socket;
    const add = socket.addEventListener.bind(socket);
    const intercept = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type !== "message") return add(type, listener, options);
      const deliver = (event: Event) => {
        if (typeof listener === "function") listener.call(socket, event);
        else listener.handleEvent(event);
      };
      return add(
        "message",
        (event) => {
          if (typeof event.data !== "string") return deliver(event);
          try {
            const message: unknown = JSON.parse(event.data);
            if (typeof message === "object" && message !== null) {
              const messageType = "type" in message ? message.type : undefined;
              if (messageType === "snapshot") snapshots.push(event.data);
              if (messageType === "resized" && !released) {
                held.push(() => deliver(event));
                return;
              }
            }
          } catch {
            // Not a control message; deliver it anyway.
          }
          deliver(event);
        },
        options,
      );
    }) as typeof socket.addEventListener;
    Object.defineProperty(socket, "addEventListener", { value: intercept });
    return socket;
  };
  return {
    createSocket,
    snapshots,
    held,
    release: () => {
      released = true;
      for (const deliver of held.splice(0)) deliver();
    },
  };
}

/** xterm reserves the scrollbar's width; the canvas otherwise fills the host on either side. */
function expectFitted(label: string, rect: { host: number; canvas: number }) {
  expect(rect.canvas, `${label}: canvas is wider than the host`).toBeLessThanOrEqual(
    rect.host + 0.5,
  );
  expect(rect.canvas, `${label}: canvas is narrower than the host`).toBeGreaterThanOrEqual(
    rect.host - 24,
  );
}

test("a terminal fits after the replay snapshot, before the resize echo", async () => {
  const echoes = holdResizeEchoes();
  const client = newClient(serverTarget(), echoes.createSocket);
  await connected(client);
  const terminal = await client.connection.api.terminals.create({
    command: "/bin/cat",
    size: SIZE,
  });
  await render(
    <SizedPane name="fit" width={1640} height={979}>
      <TerminalView client={client} terminal={terminal} onFit={() => {}} />
    </SizedPane>,
  );

  // The replay snapshot resets the canvas to the 80-column PTY grid; hold the server's resize
  // echo so only a fit after that replay can fill the pane.
  await vi.waitFor(() => {
    if (echoes.snapshots.length === 0) throw new Error("the snapshot has not arrived");
  });
  await vi.waitFor(() => {
    if (echoes.held.length === 0) throw new Error("the resize echo is not waiting");
  });
  const fittedRect = await vi.waitFor(() => {
    const rect = { host: widthOf(terminalHost("fit")), canvas: widthOf(canvas("fit")) };
    if (rect.canvas < rect.host - 24 || rect.canvas > rect.host + 0.5) {
      throw new Error(`the canvas is still ${rect.canvas}px in a ${rect.host}px host`);
    }
    return rect;
  });
  expectFitted("1920 attach", fittedRect);
  expect(echoes.held.length).toBeGreaterThan(0);
  echoes.release();
});

test("a settled host fits locally on grow and shrink, before the resize echo", async () => {
  const client = newClient();
  await connected(client);
  const terminal = await client.connection.api.terminals.create({
    command: "/bin/cat",
    size: SIZE,
  });
  const reports: { size: TerminalSize; host: number; canvas: number }[] = [];
  await render(
    <SizedPane name="resize" width={900} height={500}>
      <TerminalView
        client={client}
        terminal={terminal}
        onFit={(size) => {
          reports.push({
            size,
            host: widthOf(terminalHost("resize")),
            canvas: widthOf(canvas("resize")),
          });
        }}
      />
    </SizedPane>,
  );

  const initial = await vi.waitFor(() => {
    const report = reports.find(
      (each) => Math.abs(each.host - widthOf(terminalHost("resize"))) < 0.5,
    );
    if (report === undefined) throw new Error("the terminal has not proposed a size");
    return report;
  });
  expectFitted("initial host", { host: initial.host, canvas: initial.canvas });
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(initial.size));

  const resize = async (width: number, label: string) => {
    const from = reports.length;
    resizePane("resize", width, 500);
    // The section keeps its 8 px frame on each side, so the host is 16 px narrower than the pane.
    const expectedHost = widthOf(pane("resize")) - 16;
    const report = await vi.waitFor(() => {
      const next = reports.slice(from).find((each) => Math.abs(each.host - expectedHost) < 0.5);
      if (next === undefined) throw new Error(`the ${label} report has not arrived`);
      return next;
    });
    expectFitted(label, { host: report.host, canvas: report.canvas });
    return report;
  };

  const grown = await resize(1640, "grow");
  expect(grown.size.cols).toBeGreaterThan(initial.size.cols);
  const shrunk = await resize(900, "shrink");
  expect(shrunk.size.cols).toBeLessThan(grown.size.cols);
});

test("a reconnect re-fits at the same host size", async () => {
  const { sockets, createSocket } = trackTerminalSockets();
  const client = newClient(serverTarget(), createSocket);
  const other = newClient();
  await connected(client);
  await connected(other);
  const terminal = await client.connection.api.terminals.create({
    command: "/bin/cat",
    size: SIZE,
  });
  const reports: { size: TerminalSize; width: number; height: number }[] = [];
  await render(
    <SizedPane name="reconnect" width={500} height={340}>
      <TerminalView
        client={client}
        terminal={terminal}
        onFit={(size) => {
          const host = terminalHost("reconnect");
          reports.push({ size, width: widthOf(host), height: host.getBoundingClientRect().height });
        }}
      />
    </SizedPane>,
  );

  const own = await vi.waitFor(() => {
    const report = reports[0];
    if (report === undefined) throw new Error("the terminal has not fitted its box");
    return report;
  });
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(own.size));

  // The disconnected notice otherwise shrinks the host and makes the ResizeObserver refit. Pin
  // the host so only the attach path can produce a new report, and record any size it still sees.
  const host = terminalHost("reconnect");
  const preDrop = { width: widthOf(host), height: host.getBoundingClientRect().height };
  host.style.flex = "0 0 auto";
  host.style.height = `${preDrop.height}px`;
  const heights: number[] = [];
  const watcher = new ResizeObserver(() => heights.push(host.getBoundingClientRect().height));
  watcher.observe(host);

  // Another client fits the shared PTY while this pane stays attached, focused and visible.
  const shared = other.attach(terminal.id, idleSurface);
  const awayFit = { cols: own.size.cols + 20, rows: own.size.rows + 5 };
  shared.resize(awayFit);
  await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(awayFit));
  await vi.waitFor(() => expect(widthOf(canvas("reconnect"))).toBeGreaterThan(widthOf(host)));

  // Let any fitting already in flight land before taking the baseline.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)));
  });

  try {
    // Drop only this terminal's socket. No test action focuses the pane, changes its visibility or
    // resizes it; the reattachment's snapshot must produce a report at the pre-drop host size.
    const before = reports.length;
    const socketsBefore = sockets.length;
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("the terminal has no socket");
    socket.close();
    await vi.waitFor(() => {
      if (sockets.length === socketsBefore) throw new Error("the terminal has not reattached");
    });
    const refit = await vi.waitFor(() => {
      const report = reports
        .slice(before)
        .find(
          (each) =>
            Math.abs(each.width - preDrop.width) < 0.5 &&
            Math.abs(each.height - preDrop.height) < 0.5,
        );
      if (report === undefined) throw new Error("no report at the pre-drop host size");
      if (report.size.cols !== own.size.cols || report.size.rows !== own.size.rows) {
        throw new Error(`the terminal refitted ${report.size.cols}x${report.size.rows}`);
      }
      return report;
    });
    expect(refit.size).toEqual(own.size);
    expect(heights.every((height) => Math.abs(height - preDrop.height) < 0.5)).toBe(true);
    expect(widthOf(host)).toBeCloseTo(preDrop.width, 0);
    expect(host.getBoundingClientRect().height).toBeCloseTo(preDrop.height, 0);
    await vi.waitFor(async () => expect(await serverSize(client, terminal.id)).toEqual(own.size));
    await vi.waitFor(() => {
      const rect = { host: widthOf(host), canvas: widthOf(canvas("reconnect")) };
      if (rect.canvas < rect.host - 24 || rect.canvas > rect.host + 0.5) {
        throw new Error(`the canvas is ${rect.canvas}px in a ${rect.host}px host`);
      }
    });

    // The shared grid stays authoritative: the other client can still set it, and this pane shows
    // the clipped grid until its next attach re-asserts its own.
    const sharedAgain = { cols: awayFit.cols + 10, rows: awayFit.rows + 2 };
    shared.resize(sharedAgain);
    await vi.waitFor(async () =>
      expect(await serverSize(client, terminal.id)).toEqual(sharedAgain),
    );
    await vi.waitFor(() => expect(widthOf(canvas("reconnect"))).toBeGreaterThan(widthOf(host)));
  } finally {
    watcher.disconnect();
    shared.close();
  }
});

type ReducedMotion = "no-preference" | "reduce";

/** Chromium's media emulation is the only way to change what a CSS media query sees. */
async function emulateMotion(reducedMotion: ReducedMotion) {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: reducedMotion }],
  });
}

/** Clearing the feature list restores the host preference instead of emulating the default. */
async function clearMotion() {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
}

afterEach(async () => {
  await clearMotion();
});

/**
 * The DOM renderer draws the cursor as an element with a CSS blink animation, which is what the
 * test can observe; WebGL draws it to a canvas whose buffer is not readable after a frame.
 */
function withoutWebgl2(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  const original = descriptor?.value;
  if (typeof original !== "function") throw new Error("the canvas has no getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    ...descriptor,
    value: function (this: HTMLCanvasElement, contextId: string) {
      if (contextId === "2d") return Reflect.apply(original, this, ["2d"]);
      // WebGL2 is the renderer the component falls back from; the 2D canvas is the theme probe.
      return null;
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", descriptor);
  };
}

function terminalCursor(name: string): HTMLElement {
  const cursor = pane(name).querySelector<HTMLElement>(".xterm-cursor");
  if (!cursor) throw new Error(`the ${name} pane has no terminal cursor`);
  return cursor;
}

/** Whether the cursor is painted rather than merely present in the DOM. */
function cursorIsVisible(cursor: HTMLElement): boolean {
  return getComputedStyle(cursor).backgroundColor !== "rgba(0, 0, 0, 0)";
}

/** Samples the cursor's painted background every 200 ms; the delay is the blink cadence under test. */
async function sampleCursor(cursor: () => HTMLElement, count: number): Promise<string[]> {
  const samples: string[] = [];
  for (let index = 0; index < count; index++) {
    samples.push(getComputedStyle(cursor()).backgroundColor);
    // oxlint-disable-next-line eslint/no-await-in-loop -- the gap is the blink cadence; parallel samples would share one instant.
    if (index < count - 1) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return samples;
}

test("reduced motion keeps the cursor steady, and a live toggle resumes blinking without a remount", async () => {
  const restoreGetContext = withoutWebgl2();
  try {
    await emulateMotion("reduce");
    const client = newClient();
    await connected(client);
    const terminal = await client.connection.api.terminals.create({
      command: "/bin/cat",
      size: SIZE,
    });
    await render(
      <SizedPane name="motion" width={500} height={340}>
        <TerminalView client={client} terminal={terminal} onFit={() => {}} />
      </SizedPane>,
    );

    const host = terminalHost("motion");
    const screen = pane("motion").querySelector<HTMLElement>(".xterm-screen");
    const input = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!input || !screen) throw new Error("the terminal is not mounted");
    input.focus();
    expect(document.activeElement).toBe(input);

    // Reduced motion: no blink animation, and the cursor is drawn on every frame.
    await vi.waitFor(() => {
      const cursor = terminalCursor("motion");
      if (cursor.classList.contains("xterm-cursor-blink")) {
        throw new Error("the cursor is still blinking under reduced motion");
      }
    });
    const steadyCursor = terminalCursor("motion");
    expect(getComputedStyle(steadyCursor).animationName).toBe("none");
    expect(cursorIsVisible(steadyCursor)).toBe(true);
    const steadyFrames = await sampleCursor(() => terminalCursor("motion"), 6);
    expect(new Set(steadyFrames).size).toBe(1);
    expect(steadyFrames[0]).not.toBe("rgba(0, 0, 0, 0)");

    // Motion allowed: the same cursor gets the one-second blink animation.
    await emulateMotion("no-preference");
    const blinkingCursor = await vi.waitFor(() => {
      const cursor = terminalCursor("motion");
      if (!cursor.classList.contains("xterm-cursor-blink")) {
        throw new Error("the cursor did not resume blinking");
      }
      return cursor;
    });
    const blinkAnimation = getComputedStyle(blinkingCursor).animationName;
    expect(blinkAnimation).toMatch(/^blink_block_/);
    expect(getComputedStyle(blinkingCursor).animationIterationCount).toBe("infinite");
    const blinkedFrames = await sampleCursor(() => terminalCursor("motion"), 8);
    expect(new Set(blinkedFrames).size).toBeGreaterThan(1);

    // Turning reduced motion back on stops the blink on the same live terminal.
    await emulateMotion("reduce");
    const steadyAgain = await vi.waitFor(() => {
      const cursor = terminalCursor("motion");
      if (cursor.classList.contains("xterm-cursor-blink")) {
        throw new Error("the cursor is still blinking");
      }
      if (!cursorIsVisible(cursor)) throw new Error("the cursor is not visible");
      return cursor;
    });
    expect(getComputedStyle(steadyAgain).animationName).toBe("none");
    const steadyAgainFrames = await sampleCursor(() => terminalCursor("motion"), 6);
    expect(new Set(steadyAgainFrames).size).toBe(1);
    expect(steadyAgainFrames[0]).not.toBe("rgba(0, 0, 0, 0)");

    // No remount: the host, screen and input are the same elements.
    expect(terminalHost("motion")).toBe(host);
    expect(pane("motion").querySelector(".xterm-screen")).toBe(screen);
    expect(input.isConnected).toBe(true);

    // The stream is still attached: input after the toggles reaches the shell and comes back.
    input.focus();
    await userEvent.keyboard("after-motion{Enter}");
    await expect.poll(screenText).toContain("after-motion");
  } finally {
    restoreGetContext();
  }
});
