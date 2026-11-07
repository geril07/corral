import type { ConfigSnapshot } from "@corral/client/config-store";
import type { CorralClient } from "@corral/client/corral-client";
import { defaultClientConfig } from "@corral/protocol/config";
import { createHashHistory } from "@tanstack/react-router";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { stubClipboard } from "../../../test/clipboard.ts";
import { writeConfig } from "../../../test/config-command.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import { App as RootApp } from "../../../src/app/app.tsx";
import { createAppHistory } from "../../../src/app/history.ts";
import { KeymapProvider } from "../keymap/index.ts";
import { ConfigFileSection } from "./config-file-section.tsx";
import {
  appWithProject,
  createTaskWithShell,
  promptField,
  sessionTabs,
  taskButton,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

const CONFIG = `
[keys.bindings]
new-agent = ""

[profiles.claude-gateway]
name = "Claude gateway"
agent = "claude"
model = "claude-sonnet-4-5"
env = [{ targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "CLAUDE_SERVER_TOKEN" }]

[profiles.codex-work]
name = "Codex work"
agent = "codex"
model = "gpt-5-codex"
provider = "openai"

[profiles.opencode-team]
name = "OpenCode team"
agent = "opencode"
env = [{ targetName = "OPENAI_API_KEY", fromEnv = "TEAM_KEY" }]

[profiles.broken]
name = "Broken"
agent = "grok"
`;

const TASK_SETTINGS = `
[tasks]
agent = "codex"
workspace = "new-worktree"
worktree-root = "/srv/corral/worktrees"
branch-prefix = "corral/"
slug-mode = "generated"

[naming]
agent = "claude"
model = "claude-haiku-4-5"
timeout-seconds = 5

[projects."/repos/app"]
branch-prefix = "app/"
view = "terminal"
`;

/** A regular expression for `parts` in this order, with whitespace between and nothing else. */
function sequence(...parts: string[]): RegExp {
  const escaped = parts.map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("\\s*"));
}

const settingsHeading = () => page.getByRole("heading", { name: "Settings", level: 1 });
async function section(name: string) {
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name, exact: true })
    .click();
  return page.getByRole("region", { name, exact: true });
}
const settingsButton = () => page.getByRole("button", { name: "Settings" });
const settingsRailButton = (name: string) =>
  page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name, exact: true });
const modelEditor = () => page.getByRole("region", { name: "Models", exact: true });
const modelCheckbox = (name: string) => modelEditor().getByRole("checkbox", { name, exact: true });
const discardConfirm = () =>
  page.getByRole("alertdialog", { name: "Discard unsaved model preferences?" });
const settingsDialog = () => page.getByRole("dialog", { name: "Settings", exact: true });
const focusInSettings = () => settingsDialog().element().contains(document.activeElement);
const closeRefusal = () =>
  page.getByRole("status").filter({ hasText: "The save must finish before Settings can close." });

async function renderSettings(client: CorralClient, initialEntries = ["/settings"]) {
  await render(<App client={client} initialEntries={initialEntries} />);
  await expect.element(settingsHeading()).toBeVisible();
}

function configFileSnapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    loaded: true,
    path: "/home/me/.config/corral/config.toml",
    exists: undefined,
    config: defaultClientConfig("/data"),
    profiles: [],
    agents: [],
    problems: [],
    ...overrides,
  };
}

/** The real hash history, so browser Back and Forward go through popstate where blockers run. */
async function renderHashApp(client: CorralClient, entries: string[]) {
  const original = window.location.href;
  window.history.replaceState({}, "", `/#${entries[0]}`);
  const history = createHashHistory();
  for (const entry of entries.slice(1)) {
    history.push(entry);
    history.flush();
  }
  const rendered = await render(<RootApp client={client} history={history} />);
  return {
    ...rendered,
    history,
    restore: () => {
      history.destroy();
      window.history.replaceState({}, "", original);
    },
  };
}

/** The app history, so a browser-created entry (no TanStack state) is exercised too. */
async function renderBrowserEntryApp(client: CorralClient) {
  const original = window.location.href;
  window.history.replaceState({}, "", "/#/");
  const history = createAppHistory();
  const rendered = await render(<RootApp client={client} history={history} />);
  return {
    ...rendered,
    history,
    restore: () => {
      history.destroy();
      window.history.replaceState({}, "", original);
    },
  };
}

/** Holds the next models.save until the test releases it, then saves or fails. */
function holdNextSave(
  client: ReturnType<typeof newClient>,
  outcome: "resolve" | "reject" = "resolve",
) {
  const api = client.connection.api;
  const save = api.models.save;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gatedModels = new Proxy(api.models, {
    get(target, property, receiver) {
      if (property === "save")
        return async (input: Parameters<typeof save>[0]) => {
          await gate;
          if (outcome === "reject") throw new Error("save refused by test");
          return save(input);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperty(client.connection, "api", {
    configurable: true,
    value: new Proxy(api, {
      get(target, property, receiver) {
        if (property === "models") return gatedModels;
        return Reflect.get(target, property, receiver);
      },
    }),
  });
  return { release };
}

/** A draft the server does not have: select only Stub Two. */
async function makeModelsDirty() {
  await section("Models");
  await expect.element(modelCheckbox("Show Stub Two · stub")).toBeVisible();
  await modelEditor().getByRole("button", { name: "Only selected", exact: true }).click();
  await modelCheckbox("Show Stub Two · stub").click();
  await expect
    .element(modelEditor().getByRole("button", { name: "Save", exact: true }))
    .toBeEnabled();
}

test("the settings surface shows effective keys, profiles with reference names, and the file's problems", async () => {
  const client = newClient();
  await writeConfig(CONFIG);
  await renderSettings(client);
  await vi.waitFor(() => expect(client.config.getSnapshot().profiles).toHaveLength(3));

  await expect.element(page.getByRole("region", { name: "Appearance", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Effective keys", exact: true }))
    .not.toBeInTheDocument();
  const keys = await section("Effective keys");
  await expect.element(page.getByText("read-only", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Appearance", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(keys).toMatchTextContent(/New agent session\s*unbound/);
  await expect.element(keys).toMatchTextContent(/Settings\s*alt\+a o/);
  await expect.element(keys).toMatchTextContent("Prefix");

  const profiles = await section("Agent profiles");
  await expect.element(profiles).toMatchTextContent("Claude gateway");
  await expect.element(profiles).toMatchTextContent("claude-gateway");
  await expect.element(profiles).toMatchTextContent("model claude-sonnet-4-5");
  await expect.element(profiles).toMatchTextContent("model; gateway via env");
  await expect.element(profiles).toMatchTextContent("Codex work");
  await expect.element(profiles).toMatchTextContent("provider openai");
  await expect.element(profiles).toMatchTextContent("model and native provider");
  await expect.element(profiles).toMatchTextContent("OpenCode team");
  await expect.element(profiles).toMatchTextContent("environment only");
  await expect.element(profiles).not.toMatchTextContent("Broken");

  await profiles.getByRole("button", { name: "environment references for Claude gateway" }).click();
  await expect.element(profiles).toMatchTextContent("ANTHROPIC_AUTH_TOKEN");
  await expect.element(profiles).toMatchTextContent("CLAUDE_SERVER_TOKEN");

  await section("Effective keys");
  await section("Agent profiles");
  await expect
    .element(profiles.getByRole("button", { name: "environment references for Claude gateway" }))
    .toHaveAttribute("aria-expanded", "true");

  const config = await section("Config file");
  await expect.element(config).toMatchTextContent(client.config.getSnapshot().path);
  await expect.element(config).toMatchTextContent("never writes it");
  await expect.element(config).toMatchTextContent("Problems (1)");
  await expect.element(config).toMatchTextContent("profiles.broken");
  await expect.element(config.getByRole("button", { name: "Copy config path" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: /save/i })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /create/i })).not.toBeInTheDocument();
});

test("effective task defaults, naming and project overrides appear with the layer each came from", async () => {
  const client = newClient();
  await writeConfig(TASK_SETTINGS);
  await renderSettings(client);
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.tasks.agent.value).toBe("codex"),
  );

  await expect
    .element(await section("Task defaults"))
    .toMatchTextContent(
      sequence(
        "Agent",
        "codex",
        "global",
        "Launch profile",
        "none",
        "default",
        "Model",
        "agent default",
        "default",
        "Workspace",
        "new-worktree",
        "global",
        "Worktree root",
        "/srv/corral/worktrees",
        "global",
        "Branch prefix",
        "corral/",
        "global",
        "Slug mode",
        "generated",
        "global",
        "View",
        "chat",
        "default",
      ),
    );

  const naming = await section("Task naming");
  await expect
    .element(naming)
    .toMatchTextContent(
      sequence(
        "Launch profile",
        "none",
        "default",
        "Agent",
        "claude",
        "global",
        "Model",
        "claude-haiku-4-5",
        "global",
        "Timeout",
        "5 seconds",
        "global",
      ),
    );
  await expect.element(naming).not.toMatchTextContent("No naming profile or agent is set");

  await expect
    .element(await section("Project overrides"))
    .toMatchTextContent(
      sequence(
        "/repos/app",
        "no added project has this path",
        "Branch prefix",
        "app/",
        "project",
        "View",
        "terminal",
        "project",
      ),
    );
});

test("an empty naming section says seed titles stay, and no project entry reads as none", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  await renderSettings(client);
  await vi.waitFor(() => expect(client.config.getSnapshot().config.tasks.agent.value).toBe("pi"));

  const naming = await section("Task naming");
  await expect.element(naming).toMatchTextContent("No naming profile or agent is set");
  await expect.element(naming).toMatchTextContent("keeps the title derived from its prompt");

  await expect
    .element(await section("Project overrides"))
    .toMatchTextContent("No project overrides");

  const root = client.config.getSnapshot().config.tasks.worktreeRoot.value;
  expect(root.endsWith("worktrees")).toBe(true);
  const defaults = await section("Task defaults");
  await expect.element(defaults).toMatchTextContent(sequence("Agent", "pi", "global"));
  await expect.element(defaults).toMatchTextContent(sequence("Worktree root", root, "default"));
});

test("a project table whose path is not an added project says so, an added one does not", async () => {
  const client = newClient();
  await appWithProject(client);
  const projectPath = client.projects.getSnapshot().projects[0]?.path ?? "";
  await writeConfig(`
[projects."${projectPath}"]
branch-prefix = "app/"

[projects."/repos/not-added"]
branch-prefix = "nope/"
`);
  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[projectPath]?.branchPrefix.value).toBe(
      "app/",
    ),
  );

  const projects = await section("Project overrides");
  const added = projects.getByRole("listitem").filter({ hasText: projectPath }).first();
  await expect.element(added).toMatchTextContent(sequence("Branch prefix", "app/", "project"));
  await expect.element(added).not.toMatchTextContent("no added project has this path");

  const unknown = projects.getByRole("listitem").filter({ hasText: "/repos/not-added" }).first();
  await expect
    .element(unknown)
    .toMatchTextContent(
      sequence("no added project has this path", "Branch prefix", "nope/", "project"),
    );
});

test("the Agents section names each agent, its command, whether it is found and its chat driver", async () => {
  const client = newClient();
  await writeConfig(`
[agents.pi]
command = "/nonexistent/pi"

[agents.claude]
enabled = false
`);
  await renderSettings(client);
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.agents.pi.command.value).toBe("/nonexistent/pi"),
  );

  const agents = await section("Agents");
  // A command that is not there is reported, and Settings says so instead of claiming a launch.
  await expect
    .element(agents)
    .toMatchTextContent(sequence("pi", "/nonexistent/pi", "global", "not found", "chat", "driver"));
  // Disabled in the file, found on the host, and shown as chat by this build's driver.
  await expect
    .element(agents)
    .toMatchTextContent(
      sequence("claude", "claude", "default", "found", "chat", "driver", "disabled"),
    );
  // Every agent in this build has a chat driver.
  await expect
    .element(agents)
    .toMatchTextContent(sequence("codex", "codex", "default", "found", "chat", "driver"));
  await expect.element(agents).toMatchTextContent("an absolute path that replaces the PATH lookup");

  await writeConfig(null);
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.agents.claude.enabled.value).toBe(true),
  );
});

test("the task sections wait for the server's config instead of showing built-in values", async () => {
  const client = newClient({ url: "ws://127.0.0.1:1", capability: "unreachable" });
  await render(<App client={client} initialEntries={["/settings"]} />);
  await expect.element(settingsHeading()).toBeVisible();

  const waiting = "waiting for the server's config";
  const defaults = await section("Task defaults");
  await expect.element(defaults).toMatchTextContent(waiting);
  await expect.element(defaults).not.toMatchTextContent("Worktree root");
  await expect.element(await section("Task naming")).toMatchTextContent(waiting);
  await expect.element(await section("Project overrides")).toMatchTextContent(waiting);

  const config = await section("Config file");
  await expect.element(config).toMatchTextContent(waiting);
  await expect.element(config).not.toMatchTextContent("No problems");
  await expect.element(config).not.toMatchTextContent("has not been created");
  await expect
    .element(config.getByRole("heading", { name: "Problems", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(config.getByRole("button", { name: "Copy config path" }))
    .not.toBeInTheDocument();
});

test("an absent config file says it has not been created, then a clean file says No problems", async () => {
  const client = newClient();
  await writeConfig(null);
  const clipboard = stubClipboard(async () => undefined);
  try {
    await renderSettings(client);
    await vi.waitFor(() => expect(client.config.getSnapshot().exists).toBe(false));

    const config = await section("Config file");
    const path = client.config.getSnapshot().path;
    await expect.element(config).toMatchTextContent(path);
    await expect.element(config).toMatchTextContent("never writes it");
    await expect
      .element(config)
      .toMatchTextContent(
        "The config file has not been created yet. Corral applies the built-in defaults.",
      );
    await expect.element(config).not.toMatchTextContent("No problems");
    await expect
      .element(config.getByRole("heading", { name: "Problems", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(config.getByRole("button", { name: "Copy config path" })).toBeVisible();
    await config.getByRole("button", { name: "Copy config path" }).click();
    await expect.element(config).toMatchTextContent("Path copied.");
    expect(clipboard.writeText).toHaveBeenLastCalledWith(path);

    await writeConfig('[tasks]\nagent = "pi"\n');
    await vi.waitFor(() => expect(client.config.getSnapshot().exists).toBe(true));
    await expect.element(config).toMatchTextContent("No problems.");
    await expect.element(config).not.toMatchTextContent("has not been created");
    await expect
      .element(config.getByRole("heading", { name: "Problems", exact: true }))
      .not.toBeInTheDocument();
    await config.getByRole("button", { name: "Copy config path" }).click();
    expect(clipboard.writeText).toHaveBeenLastCalledWith(path);
  } finally {
    clipboard.restore();
  }
});

test("a daemon without the exists field says existence is unknown", async () => {
  const clipboard = stubClipboard(async () => undefined);
  try {
    const snapshot = configFileSnapshot();
    await render(
      <KeymapProvider config={snapshot}>
        <ConfigFileSection />
      </KeymapProvider>,
    );

    await expect
      .element(page.getByText("This server does not report whether the config file exists."))
      .toBeVisible();
    await expect.element(page.getByText("No problems.")).not.toBeInTheDocument();
    await expect.element(page.getByText(/has not been created/)).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Problems", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(snapshot.path, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Copy config path" }).click();
    await expect.element(page.getByText("Path copied.")).toBeVisible();
    expect(clipboard.writeText).toHaveBeenLastCalledWith(snapshot.path);
  } finally {
    clipboard.restore();
  }
});

test("a problem at the profiles table itself is shown, not only per-profile paths", async () => {
  const client = newClient();
  await writeConfig('[profiles."bad id"]\nname = "P"\nagent = "claude"\n');
  await renderSettings(client);
  await vi.waitFor(() => expect(client.config.getSnapshot().problems).toHaveLength(1));

  const config = await section("Config file");
  await expect.element(config).toMatchTextContent("Problems (1)");
  await expect.element(config.getByText("profiles", { exact: true })).toBeVisible();
  await expect.element(config).toMatchTextContent("profile id");
});

test("config changes update the surface while it stays open", async () => {
  const client = newClient();
  await writeConfig(CONFIG);
  await renderSettings(client);
  await vi.waitFor(() => expect(client.config.getSnapshot().profiles).toHaveLength(3));

  await writeConfig(`
[profiles.live]
name = "Live profile"
agent = "pi"
model = "anthropic/claude-sonnet-4:high"
provider = "anthropic"
`);
  await vi.waitFor(() => expect(client.config.getSnapshot().profiles[0]?.id).toBe("live"));

  const profiles = await section("Agent profiles");
  await expect.element(profiles).toMatchTextContent("Live profile");
  await expect.element(profiles).toMatchTextContent("model and provider (model required)");
  await expect.element(profiles).not.toMatchTextContent("Claude gateway");
  await expect.element(await section("Config file")).toMatchTextContent("No problems");
});

test("the sidebar entry opens settings; Escape and Back return to the same task with focus on the entry", async () => {
  const client = newClient();
  const { rendered } = await appWithProject(client);
  await createTaskWithShell("Settings trip");
  const terminal = document.querySelector(".terminal-host");

  await settingsButton().click();
  expect(document.querySelector(".terminal-host")).toBe(terminal);
  await expect.element(settingsHeading()).toBeVisible();
  // A plain open has no model target: Base UI keeps starting on the rail's Appearance button.
  await expect.element(settingsRailButton("Appearance")).toHaveFocus();

  // The mounted workspace is covered, not exposed: its terminal cannot take focus and AT
  // does not read it while settings is open.
  const navigation = page
    .getByRole("navigation", { name: "workspace", includeHidden: true })
    .element();
  expect(navigation.closest("[inert]")).not.toBeNull();
  expect(navigation.closest('[aria-hidden="true"]')).not.toBeNull();

  await userEvent.keyboard("{Escape}");
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect.element(taskButton("Settings trip")).toHaveAttribute("aria-current", "true");
  await expect.element(settingsButton()).toHaveFocus();
  expect(navigation.closest("[inert]")).toBeNull();
  expect(navigation.closest('[aria-hidden="true"]')).toBeNull();

  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect.element(taskButton("Settings trip")).toHaveAttribute("aria-current", "true");
  await expect.element(settingsButton()).toHaveFocus();

  // Clean history Back is the third close path and closes without a discard prompt.
  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  rendered.history.back();
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect.element(taskButton("Settings trip")).toHaveAttribute("aria-current", "true");
  await expect.element(settingsButton()).toHaveFocus();
});

test("a dirty Models draft refuses X and Escape until Keep editing or Discard", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  const { rendered } = await appWithProject(client);
  await createTaskWithShell("Dirty settings");
  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await makeModelsDirty();

  // X / "Back to workspace": the confirm takes focus on Keep editing and the URL stays put.
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(discardConfirm()).toBeVisible();
  await expect.element(discardConfirm()).toMatchTextContent("visibility and favorites");
  await expect
    .element(discardConfirm().getByRole("button", { name: "Keep editing", exact: true }))
    .toHaveFocus();
  expect(rendered.history.location.pathname).toBe("/settings");
  await discardConfirm().getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect.element(discardConfirm()).not.toBeInTheDocument();
  await expect.element(settingsHeading()).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Back to workspace" })).toHaveFocus();
  await expect
    .element(modelEditor().getByRole("button", { name: "Save", exact: true }))
    .toBeEnabled();
  await vi.waitFor(() => expect(focusInSettings()).toBe(true));

  // Escape opens the same confirm; a second Escape closes only the confirm.
  await userEvent.keyboard("{Escape}");
  await expect.element(discardConfirm()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(discardConfirm()).not.toBeInTheDocument();
  await expect.element(settingsHeading()).toBeVisible();
  expect(rendered.history.location.pathname).toBe("/settings");
  await expect
    .element(modelEditor().getByRole("button", { name: "Save", exact: true }))
    .toBeEnabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(discardConfirm()).toBeVisible();
  await discardConfirm().getByRole("button", { name: "Keep editing", exact: true }).click();

  // Discard closes without a second prompt and returns to the task.
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(discardConfirm()).toBeVisible();
  await discardConfirm().getByRole("button", { name: "Discard and close", exact: true }).click();
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect.element(discardConfirm()).not.toBeInTheDocument();
  await expect.element(taskButton("Dirty settings")).toHaveAttribute("aria-current", "true");
  expect(rendered.history.location.pathname).toBe("/");
});

test("a dirty Models draft refuses browser Back at /settings until Keep editing or Discard", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  const { history, restore } = await renderHashApp(client, ["/", "/settings"]);
  try {
    await expect.element(settingsHeading()).toBeVisible();
    await makeModelsDirty();

    history.back();
    await expect.element(discardConfirm()).toBeVisible();
    await discardConfirm().getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await expect.element(settingsHeading()).toBeVisible();
    await expect.element(modelCheckbox("Show Stub Two · stub")).toHaveFocus();
    await expect
      .element(modelEditor().getByRole("button", { name: "Save", exact: true }))
      .toBeEnabled();
    // The popstate revert runs after the pending navigation resolves; it settles at /settings.
    await vi.waitFor(() => expect(window.location.hash).toMatch(/^#\/settings/));

    history.back();
    await expect.element(discardConfirm()).toBeVisible();
    await discardConfirm().getByRole("button", { name: "Discard and close", exact: true }).click();
    await expect.element(settingsHeading()).not.toBeInTheDocument();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
  } finally {
    restore();
  }
});

test("a dirty Models draft refuses browser Forward and stays at /settings", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  const { history, restore } = await renderHashApp(client, ["/settings", "/"]);
  try {
    history.back();
    await expect.element(settingsHeading()).toBeVisible();
    await makeModelsDirty();

    history.forward();
    await expect.element(discardConfirm()).toBeVisible();
    await discardConfirm().getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await expect.element(settingsHeading()).toBeVisible();
    await vi.waitFor(() => expect(window.location.hash).toMatch(/^#\/settings/));
  } finally {
    restore();
  }
});

async function assertBrowserCreatedForward(width: number, height: number) {
  await page.viewport(width, height);
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  const { history, restore, unmount } = await renderBrowserEntryApp(client);
  let finalHash = "";
  try {
    await settingsButton().click();
    await expect.element(settingsHeading()).toBeVisible();
    expect(history.location.pathname).toBe("/settings");

    // The address-bar equivalent: a native fragment entry has no TanStack state.
    window.location.hash = "#/";
    await expect.element(settingsHeading()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));

    history.back();
    await expect.element(settingsHeading()).toBeVisible();
    await makeModelsDirty();
    const checkbox = modelCheckbox("Show Stub Two · stub");
    const save = modelEditor().getByRole("button", { name: "Save", exact: true });
    await expect.element(checkbox).toHaveFocus();

    history.forward();
    await expect.element(discardConfirm()).toBeVisible();
    await discardConfirm().getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await expect.element(settingsHeading()).toBeVisible();
    await vi.waitFor(() => expect(window.location.hash).toMatch(/^#\/settings/));
    expect(history.location.pathname).toBe("/settings");
    await expect.element(checkbox).toBeChecked();
    await expect.element(checkbox).toHaveFocus();
    await expect
      .element(modelEditor().getByRole("status").filter({ hasText: "Unsaved changes" }))
      .toBeVisible();
    await expect.element(save).toBeEnabled();

    // Repeated Forward after Keep editing is the same blocked traversal, not a buried entry.
    history.forward();
    await expect.element(discardConfirm()).toBeVisible();
    await discardConfirm().getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await expect.element(settingsHeading()).toBeVisible();
    await vi.waitFor(() => expect(window.location.hash).toMatch(/^#\/settings/));
    expect(history.location.pathname).toBe("/settings");
    await expect.element(save).toBeEnabled();

    // Discard proceeds once to the forward entry and closes without a second prompt.
    history.forward();
    await expect.element(discardConfirm()).toBeVisible();
    await discardConfirm().getByRole("button", { name: "Discard and close", exact: true }).click();
    await expect.element(settingsHeading()).not.toBeInTheDocument();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));

    // A clean Forward closes normally, with no discard confirm.
    history.back();
    await expect.element(settingsHeading()).toBeVisible();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    history.forward();
    await expect.element(settingsHeading()).not.toBeInTheDocument();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    finalHash = window.location.hash;
  } finally {
    await unmount();
    restore();
  }
  return finalHash;
}

test("a browser-created Forward entry keeps /settings on Keep editing at 1024 and 1920", async () => {
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  try {
    expect(await assertBrowserCreatedForward(1024, 640)).toBe("#/");
    expect(await assertBrowserCreatedForward(1920, 1080)).toBe("#/");
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});

test("a close request during an in-flight save is refused and keeps the draft", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  const { history, restore } = await renderHashApp(client, ["/", "/settings"]);
  try {
    await expect.element(settingsHeading()).toBeVisible();
    await makeModelsDirty();

    const { release } = holdNextSave(client);
    const saveButton = modelEditor().getByRole("button", { name: "Save", exact: true });
    await saveButton.click();
    await expect.element(saveButton).toBeDisabled();
    await expect
      .element(modelEditor().getByRole("status").filter({ hasText: "Saving…" }))
      .toHaveTextContent("Saving…");
    await expect
      .element(modelEditor().getByRole("status").filter({ hasText: "Unsaved changes" }))
      .not.toBeInTheDocument();

    // A history close is refused and reset immediately, not held until the save settles.
    history.back();
    await expect.element(settingsHeading()).toBeVisible();
    await expect.element(closeRefusal()).toHaveLength(1);
    await vi.waitFor(() => expect(window.location.hash).toBe("#/settings"));
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await expect.element(modelCheckbox("Show Stub Two · stub")).toBeChecked();

    await page.getByRole("button", { name: "Back to workspace" }).click();
    await expect.element(closeRefusal()).toHaveLength(1);
    await expect.element(settingsHeading()).toBeVisible();
    await expect.element(discardConfirm()).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await expect.element(closeRefusal()).toHaveLength(1);
    await expect.element(settingsHeading()).toBeVisible();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await expect
      .element(modelEditor().getByRole("button", { name: "Save", exact: true }))
      .toBeDisabled();

    release();
    await expect.element(modelEditor().getByText("Saved ·", { exact: false })).toBeVisible();
    expect(window.location.hash).toBe("#/settings");
    await expect.element(closeRefusal()).not.toBeInTheDocument();
    history.back();
    await expect.element(settingsHeading()).not.toBeInTheDocument();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
  } finally {
    restore();
  }
});

test("a failed save leaves no held history close and no discard confirm", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  const { history, restore } = await renderHashApp(client, ["/", "/settings"]);
  try {
    await expect.element(settingsHeading()).toBeVisible();
    await makeModelsDirty();
    const { release } = holdNextSave(client, "reject");
    const saveButton = modelEditor().getByRole("button", { name: "Save", exact: true });
    await saveButton.click();
    await expect.element(saveButton).toBeDisabled();

    history.back();
    await expect.element(settingsHeading()).toBeVisible();
    await expect.element(closeRefusal()).toHaveLength(1);
    await vi.waitFor(() => expect(window.location.hash).toBe("#/settings"));
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await expect.element(modelCheckbox("Show Stub Two · stub")).toBeChecked();

    release();
    await expect.element(modelEditor()).toMatchTextContent("Could not save.");
    await expect.element(closeRefusal()).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#/settings");
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await expect.element(modelCheckbox("Show Stub Two · stub")).toBeChecked();
    await expect.element(saveButton).toBeEnabled();

    // After settle, a new Back is a normal dirty close, not the earlier busy refusal.
    history.back();
    await expect.element(discardConfirm()).toBeVisible();
    await expect
      .element(discardConfirm().getByRole("button", { name: "Keep editing", exact: true }))
      .toHaveFocus();
    await discardConfirm().getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect.element(discardConfirm()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/settings"));
  } finally {
    restore();
  }
});

test("settings preserve a draft and its caret, pause background keys and keep appearance on this device", async () => {
  const client = newClient();
  const { rendered } = await appWithProject(client);
  await createTaskWithShell("Keep this workspace");
  await prefixThen("t");
  await promptField().fill("Keep this unfinished prompt");
  const prompt = promptField().element();
  if (!(prompt instanceof HTMLTextAreaElement)) throw new Error("Prompt is not a textarea");
  prompt.setSelectionRange(5, 5);
  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await userEvent.keyboard("{Alt>}a{/Alt}");
  expect(document.querySelector('[aria-label="prefix mode"]')).toBeNull();
  await page.getByRole("radio", { name: "Bottom", exact: true }).click();
  await page.getByRole("button", { name: "120%", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  expect(promptField().element()).toBe(prompt);
  expect(prompt.value).toBe("Keep this unfinished prompt");
  expect(prompt.selectionStart).toBe(5);
  expect(document.documentElement.style.fontSize).toBe("120%");
  const content = page
    .getByRole("region", { name: "task content" })
    .element()
    .getBoundingClientRect();
  expect(sessionTabs().element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
    content.bottom,
  );
  await rendered.unmount();
  await render(<App client={client} />);
  expect(document.documentElement.style.fontSize).toBe("120%");
  expect(
    sessionTabs().element().closest("[data-tab-position]")?.getAttribute("data-tab-position"),
  ).toBe("bottom");
});

test("the settings action is a configurable key and a palette entry, never a hardcoded chord", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await writeConfig('[keys.bindings]\nsettings = "q"\n');
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.keys.bindings["settings"]).toBe("q"),
  );

  await prefixThen("o");
  await expect.element(settingsHeading()).not.toBeInTheDocument();

  await prefixThen("q");
  await expect.element(settingsHeading()).toBeVisible();
  await expect.element(settingsRailButton("Appearance")).toHaveFocus();
  await expect.element(await section("Effective keys")).toMatchTextContent(/Settings\s*alt\+a q/);

  await userEvent.keyboard("{Escape}");
  await expect.element(settingsHeading()).not.toBeInTheDocument();

  await prefixThen(" ");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect
    .element(palette.getByRole("option", { name: /Settings/ }))
    .toMatchTextContent("alt+a q");
  await userEvent.keyboard("settings{Enter}");
  await expect.element(palette).not.toBeInTheDocument();
  await expect.element(settingsHeading()).toBeVisible();
  await expect.element(settingsRailButton("Appearance")).toHaveFocus();
});
