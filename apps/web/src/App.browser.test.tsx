import { createCorralClient, type CorralClient } from "@corral/client/corral-client";
import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { serverUrl } from "../test/server-url.ts";
import { App } from "./App.tsx";

const claimNextProtocolVersion = (url: string) =>
  new WebSocket(url.replace(`protocol=${PROTOCOL_VERSION}`, `protocol=${PROTOCOL_VERSION + 1}`));

const SIZE = { cols: 80, rows: 24 };
const clients: CorralClient[] = [];

/** A client for the real server, closed after the test. */
function newClient(url = serverUrl(), createSocket?: (url: string) => WebSocket) {
  const client = createCorralClient({
    serverUrl: url,
    backoff: { initialMs: 20, maxMs: 100 },
    ...(createSocket ? { createSocket } : {}),
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  // Terminals belong to the server, not the test: close what the test left behind.
  const { api } = newClient().connection;
  await vi.waitFor(async () => {
    const listed = await api.terminals.list();
    await Promise.all(listed.map((terminal) => api.terminals.close({ id: terminal.id })));
    if (listed.length > 0) throw new Error("terminals were still open");
  });
  for (const client of clients.splice(0)) client.close();
});

function screenText(): string {
  return window.corralScreenText?.() ?? "";
}

test("the prefix chord arms prefix mode and the next key disarms it", async () => {
  await render(<App client={newClient()} prefix="alt+a" />);
  const indicator = page.getByRole("status", { name: "prefix mode" });

  await userEvent.keyboard("{Alt>}a{/Alt}");
  await expect.element(indicator).toBeVisible();

  await userEvent.keyboard("q");
  await expect.element(indicator).not.toBeInTheDocument();
});

test("the same key without the prefix's modifier does not arm prefix mode", async () => {
  await render(<App client={newClient()} prefix="alt+a" />);
  await userEvent.keyboard("a");
  await expect.element(page.getByRole("status", { name: "prefix mode" })).not.toBeInTheDocument();
});

const terminalItems = () =>
  page.getByRole("navigation", { name: "terminals" }).getByRole("listitem");
const selectButton = (index: number) => terminalItems().nth(index).getByRole("button").first();
const prefixThen = (key: string) => userEvent.keyboard(`{Alt>}a{/Alt}${key}`);

test("prefix then c opens a terminal that takes the keyboard straight away", async () => {
  await render(<App client={newClient()} prefix="alt+a" />);
  await expect.element(page.getByText(/No terminals/)).toBeVisible();

  await prefixThen("c");
  await expect.element(terminalItems()).toHaveLength(1);
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  await userEvent.keyboard("echo it-is-$((6*7)){Enter}");
  await expect.poll(screenText).toContain("it-is-42");
});

test("the prefix and its action key are not typed into the terminal", async () => {
  await render(<App client={newClient()} prefix="alt+a" />);
  await prefixThen("c");
  await expect.element(terminalItems()).toHaveLength(1);

  // Only one terminal, so p changes nothing; if it leaked, sh would report "p: not found".
  await prefixThen("p");
  await userEvent.keyboard("echo marker-$((1+1)){Enter}");

  await expect.poll(screenText).toContain("marker-2");
  expect(screenText()).not.toContain("not found");
});

test("prefix n and p switch between terminals, wrapping around", async () => {
  const client = newClient();
  await render(<App client={client} prefix="alt+a" />);
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(terminalItems()).toHaveLength(2);
  await expect.element(selectButton(1)).toHaveAttribute("aria-current", "true");

  await prefixThen("n");
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
  await prefixThen("p");
  await expect.element(selectButton(1)).toHaveAttribute("aria-current", "true");
  await prefixThen("n");
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  await userEvent.keyboard("echo first-$((2*3)){Enter}");
  await expect.poll(screenText).toContain("first-6");
});

test("prefix x closes the active terminal and the neighbour takes over", async () => {
  await render(<App client={newClient()} prefix="alt+a" />);
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(terminalItems()).toHaveLength(2);

  await prefixThen("x");
  await expect.element(terminalItems()).toHaveLength(1);
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  await prefixThen("x");
  await expect.element(page.getByText(/No terminals/)).toBeVisible();
});

test("clicking a terminal in the list shows it and keeps typing going to the terminal", async () => {
  await render(<App client={newClient()} prefix="alt+a" />);
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(terminalItems()).toHaveLength(2);

  await selectButton(0).click();
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
  await userEvent.keyboard("echo clicked-$((5+5)){Enter}");

  await expect.poll(screenText).toContain("clicked-10");
});

test("a terminal whose process ended stays listed as exited until it is closed", async () => {
  const client = newClient();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  await client.connection.api.terminals.create({
    command: "/bin/sh",
    args: ["-c", "echo bye; exit 3"],
    size: SIZE,
  });
  await render(<App client={client} prefix="alt+a" />);

  await expect.element(page.getByText("exited (3)")).toBeVisible();
  await expect.element(page.getByRole("status", { name: "terminal exited" })).toBeVisible();
  await expect.poll(screenText).toContain("bye");

  await prefixThen("x");
  await expect.element(page.getByText(/No terminals/)).toBeVisible();
});

test("a server on another protocol version gets a clear message instead of the workspace", async () => {
  await render(<App client={newClient(serverUrl(), claimNextProtocolVersion)} prefix="alt+a" />);

  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(page.getByText(/The server speaks protocol version 1;/)).toBeVisible();
  await expect.element(page.getByRole("navigation", { name: "terminals" })).not.toBeInTheDocument();
});

test("an unreachable server shows as disconnected and the workspace stays up", async () => {
  await render(<App client={newClient("ws://127.0.0.1:1")} prefix="alt+a" />);

  await expect
    .element(page.getByRole("status", { name: "connection" }))
    .toHaveTextContent("Disconnected. Retrying…");
  await expect.element(page.getByRole("navigation", { name: "terminals" })).toBeVisible();
});
