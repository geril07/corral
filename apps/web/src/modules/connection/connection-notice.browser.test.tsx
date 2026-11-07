import { resolveServerTarget, type ServerTargetStorage } from "@corral/client/bootstrap";
import { capabilityProtocols } from "@corral/protocol/handshake";
import type { ConnectionState } from "@corral/client/connection-state";
import type { CreateSocket } from "@corral/client/reconnecting-socket";
import type { ServerTarget } from "@corral/protocol/server-target";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import {
  focusedIsTerminal,
  appWithProject,
  createTaskWithShell,
  shellTabs,
  taskButton,
} from "../../../test/task-flows.tsx";
import { realServerClients, screenText } from "../../../test/real-client.ts";
import { serverTarget } from "../../../test/server-url.ts";
import { ConnectionNotice } from "./connection-notice.tsx";
import { CapabilityForm, StartupNotice } from "./startup-notice.tsx";

const { newClient } = realServerClients();
const connectionStatus = () => page.getByRole("button", { name: /^connection:/ });

function memoryStorage(initial?: ServerTarget): ServerTargetStorage & {
  value: ServerTarget | undefined;
} {
  const store = {
    value: initial,
    read: () => store.value,
    write: (target: ServerTarget) => {
      store.value = target;
    },
  };
  return store;
}

test("a boot failure is framed, names the cause, and offers the field and Reload", async () => {
  const reload = vi.fn<() => void>();
  const useCapability = vi.fn<(capability: string) => void>();
  const screen = await render(
    <StartupNotice
      problem={{
        kind: "boot",
        failure: { kind: "no-capability" },
        message: "No server capability.",
      }}
      host="browser"
      onReload={reload}
      onUseCapability={useCapability}
    />,
  );

  await expect.element(page.getByRole("heading", { name: "No server capability" })).toBeVisible();
  await expect.element(page.getByText(/opened without the capability/)).toBeVisible();
  const field = page.getByRole("textbox", { name: "Capability" });
  await expect.element(field).toHaveFocus();
  await userEvent.fill(field, "pasted-token");
  await userEvent.keyboard("{Enter}");
  expect(useCapability).toHaveBeenCalledWith("pasted-token");

  await page.getByRole("button", { name: "Reload" }).click();
  expect(reload).toHaveBeenCalled();
  await screen.unmount();
});

test("a stored pair for another server and an invalid address name the cause", async () => {
  const other = await render(
    <StartupNotice
      problem={{
        kind: "boot",
        failure: {
          kind: "other-server",
          storedUrl: "ws://127.0.0.1:4100",
          url: "ws://127.0.0.1:4200",
        },
        message: "",
      }}
      host="browser"
      onReload={() => undefined}
      onUseCapability={() => undefined}
    />,
  );
  await expect
    .element(page.getByRole("heading", { name: "The saved capability belongs to another server" }))
    .toBeVisible();
  await expect
    .element(page.getByText(/belongs to ws:\/\/127\.0\.0\.1:4100, not ws:\/\/127\.0\.0\.1:4200/))
    .toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Capability" })).toBeVisible();
  await other.unmount();

  const invalid = await render(
    <StartupNotice
      problem={{
        kind: "boot",
        failure: { kind: "invalid-url", given: "not-a-url" },
        message: "server URL must be ws:// or wss://: not-a-url",
      }}
      host="browser"
      onReload={() => undefined}
      onUseCapability={() => undefined}
    />,
  );
  await expect
    .element(page.getByRole("heading", { name: "The server address is not valid" }))
    .toBeVisible();
  await expect.element(page.getByText(/not "not-a-url"/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
  // Fixing the address is the only action: a capability cannot make an invalid URL valid.
  await expect.element(page.getByRole("textbox", { name: "Capability" })).not.toBeInTheDocument();
  await invalid.unmount();
});

test("an unreachable startup names the attempt and elapsed time and retries", async () => {
  const retry = vi.fn<() => void>();
  const screen = await render(
    <StartupNotice
      problem={{
        kind: "unreachable",
        attempt: 3,
        startedAt: Date.now() - 2500,
        serverUrl: "ws://127.0.0.1:4100",
      }}
      host="browser"
      onRetry={retry}
      onUseCapability={() => undefined}
    />,
  );

  await expect
    .element(page.getByRole("heading", { name: "Cannot reach the server" }))
    .toBeVisible();
  await expect.element(page.getByText(/ws:\/\/127\.0\.0\.1:4100/)).toBeVisible();
  await expect.element(page.getByText(/Attempt 3 · \d+ s/)).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Capability" })).toHaveFocus();
  await page.getByRole("button", { name: "Retry now" }).click();
  expect(retry).toHaveBeenCalled();
  await screen.unmount();
});

test("a protocol mismatch reloads in a browser and asks a desktop user to restart", async () => {
  const reload = vi.fn<() => void>();
  const browser = await render(
    <StartupNotice
      problem={{ kind: "protocol-mismatch", serverProtocolVersion: 12 }}
      host="browser"
      onReload={reload}
    />,
  );
  await expect
    .element(
      page.getByRole("heading", { name: "This app and the server cannot talk to each other" }),
    )
    .toBeVisible();
  await expect.element(page.getByText(/speaks protocol version 12/)).toBeVisible();
  await page.getByRole("button", { name: "Reload" }).click();
  expect(reload).toHaveBeenCalled();
  await browser.unmount();

  const desktop = await render(
    <StartupNotice
      problem={{ kind: "protocol-mismatch", serverProtocolVersion: 12 }}
      host="desktop"
      onReload={reload}
    />,
  );
  await expect
    .element(page.getByText("Stop that server and start the app again.", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  await desktop.unmount();

  const refused = await render(
    <StartupNotice
      problem={{ kind: "capability-refused", attempt: 2, startedAt: Date.now() - 1500 }}
      host="desktop"
    />,
  );
  await expect
    .element(page.getByText("Stop that server and start the app again.", { exact: false }))
    .toBeVisible();
  await refused.unmount();
});

test("a capability that is not a token is refused in place before it reaches the hash", async () => {
  const useCapability = vi.fn<(capability: string) => void>();
  const screen = await render(<CapabilityForm onSubmit={useCapability} />);
  const field = page.getByRole("textbox", { name: "Capability" });

  await userEvent.fill(field, "bad token");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toMatchTextContent(/not a valid capability/);
  expect(useCapability).not.toHaveBeenCalled();

  await userEvent.fill(field, "valid-token_123");
  await userEvent.keyboard("{Enter}");
  expect(useCapability).toHaveBeenCalledWith("valid-token_123");
  await screen.unmount();
});

test("the footer connection status keeps the button but announces the drop", async () => {
  const open = vi.fn<(opener: HTMLElement) => void>();
  await render(
    <ConnectionNotice
      state={{ status: "disconnected", attempt: 3, startedAt: Date.now() - 2000 }}
      onOpen={open}
    />,
  );

  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Cannot reach the server. Attempt 3.");
  const opener = page.getByRole("button", { name: /^connection:/ });
  await expect.element(opener).toBeVisible();
  await expect.element(opener).toHaveTextContent("Offline");
  expect(opener.element().getAttribute("aria-label")).toMatch(
    /^connection: Cannot reach the server · attempt 3 · \d+ s$/,
  );
  const word = opener.element().querySelector<HTMLElement>('[data-slot="connection-state"]');
  if (word === null) throw new Error("the connection opener has no state word");
  await userEvent.hover(word);
  await expect
    .element(page.getByRole("tooltip"))
    .toMatchTextContent(/Cannot reach the server · attempt 3 · \d+ s/);
});

test("every connection state shows its word and keeps the whole sentence in its name", async () => {
  const startedAt = Date.now();
  const cases: { state: ConnectionState; word: string; name: RegExp }[] = [
    {
      state: { status: "connecting", attempt: 2, startedAt },
      word: "Connecting",
      name: /^connection: Connecting to the server · attempt 2 · \d+ s$/,
    },
    {
      state: { status: "disconnected", attempt: 2, startedAt },
      word: "Offline",
      name: /^connection: Cannot reach the server · attempt 2 · \d+ s$/,
    },
    {
      state: { status: "capability-refused", attempt: 2, startedAt },
      word: "Refused",
      name: /^connection: The server refused this capability · attempt 2 · \d+ s$/,
    },
    {
      state: { status: "invalid-capability", detail: "bad token" },
      word: "Invalid",
      name: /^connection: That capability cannot be used$/,
    },
    {
      state: { status: "protocol-mismatch", serverProtocolVersion: 12 },
      word: "Mismatch",
      name: /^connection: Protocol mismatch$/,
    },
  ];
  for (const { state, word, name } of cases) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each state replaces the previous render
    const screen = await render(<ConnectionNotice state={state} onOpen={() => {}} />);
    const opener = page.getByRole("button", { name: /^connection:/ });
    // oxlint-disable-next-line eslint/no-await-in-loop -- each state replaces the previous render
    await expect.element(opener).toHaveTextContent(word);
    expect(opener.element().getAttribute("aria-label")).toMatch(name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- each state replaces the previous render
    await screen.unmount();
  }
});

test("a refused capability names attempt and time, and recovery reattaches both socket kinds", async () => {
  const target = serverTarget();
  const rotated = "rotated-capability_2026";
  const original = window.location.href;
  // The dev page carries the tokenless ?server= that the bootstrap pairs with its stored target.
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}?server=${encodeURIComponent(target.url)}`,
  );
  const sockets: WebSocket[] = [];
  const handshakes: { url: string; protocols: string[] }[] = [];
  const createSocket: CreateSocket = (url, protocols) => {
    handshakes.push({ url, protocols });
    // The test server only knows its own capability; a "rotated" one is translated here so the
    // client still proves which token it read and offered on the new sockets.
    const socket = new WebSocket(
      url,
      protocols[1] === rotated ? capabilityProtocols(target.capability) : protocols,
    );
    sockets.push(socket);
    return socket;
  };
  const storage = memoryStorage(target);
  const refreshServer = () =>
    resolveServerTarget({
      location: window.location,
      storage,
      applyHash: (hash) =>
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${hash}`,
        ),
    });
  const client = newClient(target, createSocket, {
    // Long enough that only the dialog's own action reconnects in this test.
    backoff: { initialMs: 60_000, maxMs: 60_000 },
    refreshServer,
  });
  try {
    await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
    await appWithProject(client);
    await createTaskWithShell("Keeps its place");
    await userEvent.keyboard("echo keep-$((2+3)){Enter}");
    await expect.poll(screenText).toContain("keep-5");
    expect(sockets.length).toBeGreaterThanOrEqual(2);

    // The server refuses the capability on both the RPC socket and the terminal's own socket.
    for (const socket of sockets) {
      socket.dispatchEvent(new CloseEvent("close", { code: 4002 }));
      socket.close();
    }
    await expect
      .poll(() => client.connection.state.getSnapshot().status)
      .toBe("capability-refused");
    await expect.element(connectionStatus()).toHaveTextContent("Refused");
    expect(connectionStatus().element().getAttribute("aria-label")).toMatch(
      /^connection: The server refused this capability · attempt 1 · \d+ s$/,
    );
    await expect
      .element(page.getByRole("status", { name: "terminal connection" }))
      .toMatchTextContent(/refused this terminal's capability/);

    await connectionStatus().click();
    const dialog = page.getByRole("dialog", { name: "The server refused this capability" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText(/Attempt 1 · \d+ s/)).toBeVisible();
    const field = dialog.getByRole("textbox", { name: "Capability" });
    await expect.element(field).toHaveFocus();
    // The prefix never handles keys while the dialog is open: c is typed into the field and
    // starts no terminal, because the chord armed nothing.
    await userEvent.keyboard("{Alt>}a{/Alt}c");
    await expect.element(field).toHaveValue("c");
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(connectionStatus()).toHaveFocus();

    await connectionStatus().click();
    await expect.element(field).toHaveFocus();
    await field.fill(rotated);
    await userEvent.keyboard("{Enter}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(connectionStatus()).not.toBeInTheDocument();
    await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");

    // The pasted capability is the one stored and offered on both reconnected sockets.
    expect(storage.value).toEqual({ url: target.url, capability: rotated });
    const offered = handshakes.filter((each) => each.protocols[1] === rotated);
    expect(offered.some((each) => each.url.includes("/rpc?protocol="))).toBe(true);
    expect(offered.some((each) => each.url.includes("/terminals/"))).toBe(true);

    await expect.element(taskButton("Keeps its place")).toHaveAttribute("aria-current", "true");
    await expect.element(shellTabs()).toHaveLength(1);
    expect(screenText()).toContain("keep-5");
    await expect
      .element(page.getByRole("status", { name: "terminal connection" }))
      .not.toBeInTheDocument();
    await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
    await userEvent.keyboard("echo after-$((4+5)){Enter}");
    await expect.poll(screenText).toContain("after-9");
  } finally {
    window.history.replaceState(null, "", original);
  }
});
