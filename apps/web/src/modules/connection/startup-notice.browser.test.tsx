import { resolveServerTarget, type ServerTargetStorage } from "@corral/client/bootstrap";
import { capabilityProtocols } from "@corral/protocol/handshake";
import type { CreateSocket } from "@corral/client/reconnecting-socket";
import type { ServerTarget } from "@corral/protocol/server-target";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { appWithProject, taskWithShell } from "../../../test/task-flows.tsx";
import { realServerClients, screenText } from "../../../test/real-client.ts";
import { serverTarget } from "../../../test/server-url.ts";
import { CapabilityForm, StartupNotice } from "./startup-notice.tsx";

const { newClient } = realServerClients();
const card = (title: string) => page.getByRole("button", { name: new RegExp(title) });

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

test("a refused capability names itself in the banner and leaves the task intact", async () => {
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
    const { project } = await appWithProject(client);
    await taskWithShell(client, project.id, "Keeps its place");
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
    await expect
      .element(page.getByRole("status", { name: "terminal connection" }))
      .toMatchTextContent(/refused this terminal's capability/);

    // The banner above the working area names the refusal; the task keeps its place and its
    // terminal keeps the output it already has.
    await expect.element(page.getByText(/^The server refused this capability · /)).toBeVisible();
    await expect.element(card("Keeps its place")).toHaveAttribute("aria-current", "true");
    expect(screenText()).toContain("keep-5");
  } finally {
    window.history.replaceState(null, "", original);
  }
});
