import { resolveServerTarget, type ServerTargetStorage } from "@corral/client/bootstrap";
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
import { StartupNotice } from "./startup-notice.tsx";

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
  await expect.element(page.getByText("Quit and reopen the app.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  await desktop.unmount();
});

test("the connection status opens recovery; a pasted capability reconnects with the workspace intact", async () => {
  const target = serverTarget();
  const original = window.location.href;
  // The dev page carries the tokenless ?server= that the bootstrap pairs with its stored target.
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}?server=${encodeURIComponent(target.url)}`,
  );
  const sockets: WebSocket[] = [];
  const createSocket: CreateSocket = (url, protocols) => {
    const socket = new WebSocket(url, protocols);
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

    sockets[0]?.close(4000, "test drop");
    await expect
      .element(connectionStatus())
      .toMatchTextContent(/Cannot reach the server · attempt 1/);

    await connectionStatus().click();
    const dialog = page.getByRole("dialog", { name: "Cannot reach the server" });
    await expect.element(dialog).toBeVisible();
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
    await field.fill(target.capability);
    await userEvent.keyboard("{Enter}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(connectionStatus()).not.toBeInTheDocument();
    await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");

    await expect.element(taskButton("Keeps its place")).toHaveAttribute("aria-current", "true");
    await expect.element(shellTabs()).toHaveLength(1);
    expect(screenText()).toContain("keep-5");
    await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  } finally {
    window.history.replaceState(null, "", original);
  }
});
