import type { CorralClient } from "@corral/client/corral-client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import {
  appWithProject,
  createTask,
  focusedIsTerminal,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const terminalButtons = () => workspace().getByRole("button", { name: /^sh · / });
const picker = () => page.getByRole("dialog", { name: "New agent session" });
const palette = () => page.getByRole("dialog", { name: "Command palette" });
const paletteItem = (name: RegExp) => palette().getByRole("option", { name });
const keyHint = () => page.getByLabelText("key hint");

/** Writes the file and waits until the client has the config the server derived from it. */
async function applyConfig(client: CorralClient, text: string, applied: () => void) {
  await writeConfig(text);
  await vi.waitFor(applied);
  await expect.poll(() => client.config.getSnapshot().loaded).toBe(true);
}

test("a config file rebinds an action and the key hint follows it", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Keymap");
  await applyConfig(client, '[keys.bindings]\nnew-agent = "a"\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["new-agent"]).toBe("a"),
  );
  await expect.element(keyHint()).toMatchTextContent("alt+a then c a x");

  await prefixThen(" ");
  await expect.element(paletteItem(/New agent session/)).toMatchTextContent("alt+a a");
  await userEvent.keyboard("{Escape}");

  await prefixThen("a");
  await expect.element(picker()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(picker()).not.toBeInTheDocument();

  await prefixThen("s");
  await expect.element(picker()).not.toBeInTheDocument();
});

test("a config file unbinds an action, whose key then does nothing", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys.bindings]\nnew-terminal = ""\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["new-terminal"]).toBeNull(),
  );
  await expect.element(keyHint()).not.toMatchTextContent("alt+a then c");

  await prefixThen("c");

  await expect.element(terminalButtons()).toHaveLength(0);
});

test("a config file changes the prefix and every action follows it", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys]\nprefix = "ctrl+b"\n', () =>
    expect(client.config.getSnapshot().config.keys.prefix).toBe("ctrl+b"),
  );
  await expect.element(keyHint()).toMatchTextContent("ctrl+b then c");

  await userEvent.keyboard("{Control>}b{/Control}c");
  await expect.element(terminalButtons()).toHaveLength(1);

  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
});

test("config problems show as a notice whose dialog lists each one with the file path", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys.bindings]\nnew-agent = "hyper+q"\nboard = "ctrl+w"\n', () =>
    expect(client.config.getSnapshot().problems).toHaveLength(2),
  );
  const path = client.config.getSnapshot().path;

  await page.getByRole("button", { name: "config: 2 problems" }).click();
  const dialog = page.getByRole("dialog", { name: "Config problems" });

  await expect.element(dialog).toMatchTextContent(path);
  await expect.element(dialog).toMatchTextContent("error");
  await expect.element(dialog).toMatchTextContent("keys.bindings.new-agent");
  await expect.element(dialog).toMatchTextContent('unknown modifier "hyper" in "hyper+q"');
  await expect.element(dialog).toMatchTextContent("warning");
  await expect.element(dialog).toMatchTextContent("keys.bindings.board");
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

test("the palette opens from its key, shows bindings, filters, runs an action and Escape returns to the terminal", async () => {
  const client = newClient();
  await render(<App client={client} />);

  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await expect.element(palette().getByRole("combobox", { name: "Commands" })).toHaveFocus();
  await expect.element(paletteItem(/New terminal/)).toMatchTextContent("alt+a c");
  await expect.element(paletteItem(/Stop session/)).toHaveAttribute("aria-disabled", "true");

  await userEvent.keyboard("new terminal");
  await expect.element(paletteItem(/New terminal/)).toBeVisible();
  await expect.element(paletteItem(/Add project/)).not.toBeInTheDocument();

  await userEvent.keyboard("{Enter}");
  await expect.element(palette()).not.toBeInTheDocument();
  await expect.element(terminalButtons()).toHaveLength(1);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await userEvent.keyboard("agent");
  await expect.element(paletteItem(/New agent session/)).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(palette()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo back-$((7+7)){Enter}");
  await expect.poll(() => window.corralScreenText?.() ?? "").toContain("back-14");
});
