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
import { App, renderApp } from "../../../test/render-app.tsx";
import { createGitRepo } from "../../../test/git-repo.ts";
import { App as RootApp } from "../../../src/app/app.tsx";
import { createAppHistory } from "../../../src/app/history.ts";
import { KeymapProvider } from "../keymap/index.ts";
import { DiagnosticsSection } from "./diagnostics-section.tsx";
import { promptField } from "../../../test/task-flows.tsx";

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
  return new RegExp(escaped.join("\\s*(?:·\\s*)?"));
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

/** This shell's tests create projects and tasks through the API; the old dialogs are gone. */
async function connected(client: CorralClient) {
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
}

async function appWithProjectViaApi(client: CorralClient) {
  await connected(client);
  const repo = await createGitRepo("repo");
  const project = await client.connection.api.projects.add({ path: repo });
  const rendered = await renderApp(client);
  await vi.waitFor(() =>
    expect(client.projects.getSnapshot().projects.some((each) => each.id === project.id)).toBe(
      true,
    ),
  );
  return { client, repo, rendered, project };
}

/** A selected task in a real project, opened by its route, so Settings has a task to return to. */
async function appWithTaskViaApi(client: CorralClient, title: string) {
  await connected(client);
  const repo = await createGitRepo("repo");
  const project = await client.connection.api.projects.add({ path: repo });
  const task = await client.connection.api.tasks.create({
    projectId: project.id,
    title,
    workspace: { type: "main-worktree" },
  });
  const rendered = await renderApp(client, [`/?task=${task.id}`]);
  await expect.element(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();
  return { client, repo, rendered, project, task };
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
    .element(page.getByRole("region", { name: "Keyboard", exact: true }))
    .not.toBeInTheDocument();
  const keys = await section("Keyboard");
  await expect
    .element(page.getByRole("region", { name: "Appearance", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(keys).toMatchTextContent(/New agent session\s*unbound/);
  await expect.element(keys).toMatchTextContent(/Settings\s*alt\+a o/);
  await expect.element(keys).toMatchTextContent("Prefix");

  const profiles = await section("Profiles");
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

  await section("Keyboard");
  await section("Profiles");
  await expect
    .element(profiles.getByRole("button", { name: "environment references for Claude gateway" }))
    .toHaveAttribute("aria-expanded", "true");

  const config = await section("Diagnostics");
  await expect.element(config).toMatchTextContent(client.config.getSnapshot().path);
  await expect.element(config).toMatchTextContent("never writes it");
  await expect.element(config).toMatchTextContent("Problems (1)");
  await expect.element(config).toMatchTextContent("profiles.broken");
  await expect.element(config.getByRole("button", { name: "Copy config path" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: /save/i })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /create/i })).not.toBeInTheDocument();
});

test("a conflicting binding shows its fallback chord and the server's reason on the action row", async () => {
  const client = newClient();
  await writeConfig('[keys.bindings]\nnew-task = "shift+s"\nsettings = "shift+s"\n');
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  try {
    await page.viewport(1024, 640);
    await renderSettings(client);
    await vi.waitFor(() => expect(client.config.getSnapshot().problems).toHaveLength(2));

    const keys = await section("Keyboard");
    const row = (title: RegExp) => {
      const found = [...keys.element().querySelectorAll<HTMLElement>(".settings-row")].find(
        (candidate) =>
          title.test(candidate.querySelector(".settings-row-title")?.textContent ?? ""),
      );
      if (found === undefined) throw new Error(`no settings row matches ${String(title)}`);
      return found;
    };
    const newTask = row(/^New task$/);
    const settings = row(/^Settings$/);
    const newTaskReason = 'the chord "shift+s" is also used by settings';
    const settingsReason = 'the chord "shift+s" is also used by new-task';

    // The fallback chord and the server's own reason are in the same category.
    for (const part of ["New task", "alt+a t", newTaskReason]) {
      expect(newTask.textContent).toContain(part);
    }
    expect(keys.element().textContent).toContain(newTaskReason);
    for (const part of ["Settings", "alt+a o", settingsReason]) {
      expect(settings.textContent).toContain(part);
    }

    // The row exposes the reason as its accessible description, not only as visible text.
    for (const [entry, reason] of [
      [newTask, newTaskReason],
      [settings, settingsReason],
    ] as const) {
      const describedBy = entry.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();
      expect(document.getElementById(describedBy ?? "")?.textContent).toBe(reason);
    }

    // An action without a problem keeps its one-line chord row.
    const newTerminal = row(/^New terminal$/);
    for (const part of ["New terminal", "alt+a c"]) {
      expect(newTerminal.textContent).toContain(part);
    }
    expect(newTerminal.textContent).not.toContain("also used by");
    expect(newTerminal.getAttribute("aria-describedby")).toBeNull();

    const assertNoOverflow = () => {
      expect(keys.element().scrollWidth).toBeLessThanOrEqual(keys.element().clientWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    };
    assertNoOverflow();

    await page.viewport(1920, 1080);
    await expect.element(keys).toBeVisible();
    await expect.element(newTask).toBeVisible();
    await expect.element(settings).toBeVisible();
    assertNoOverflow();
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});

test("effective task defaults and naming appear with the layer each came from", async () => {
  const client = newClient();
  await writeConfig(TASK_SETTINGS);
  await renderSettings(client);
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.tasks.agent.value).toBe("codex"),
  );

  await expect
    .element(await section("Defaults"))
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

  const naming = await section("Naming");
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
});

test("an empty naming section says seed titles stay, and Projects starts with a picker", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  await renderSettings(client);
  await vi.waitFor(() => expect(client.config.getSnapshot().config.tasks.agent.value).toBe("pi"));

  const naming = await section("Naming");
  await expect.element(naming).toMatchTextContent("No naming profile or agent is set");
  await expect.element(naming).toMatchTextContent("keeps the title derived from its prompt");

  const projects = await section("Projects");
  await expect.element(projects).toMatchTextContent("No projects yet");
  await expect.element(projects).toMatchTextContent("Add one from the workspace sidebar");

  const root = client.config.getSnapshot().config.tasks.worktreeRoot.value;
  expect(root.endsWith("worktrees")).toBe(true);
  const defaults = await section("Defaults");
  await expect.element(defaults).toMatchTextContent(sequence("Agent", "pi", "global"));
  await expect.element(defaults).toMatchTextContent(sequence("Worktree root", root, "default"));
});

test("a project table whose path is not an added project says so on its own page", async () => {
  const client = newClient();
  await appWithProjectViaApi(client);
  const project = client.projects.getSnapshot().projects[0]!;
  await writeConfig(`
[tasks]
agent = "pi"

[projects."${project.path}"]
branch-prefix = "app/"

[projects."/repos/not-added"]
branch-prefix = "nope/"
`);
  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[project.path]?.branchPrefix.value).toBe(
      "app/",
    ),
  );

  const projects = await section("Projects");
  const picker = projects.getByRole("button", { name: `Project settings for ${project.name}` });
  await expect.element(picker).toBeVisible();
  await expect
    .element(projects.getByRole("button", { name: "Project settings for not-added" }))
    .toBeVisible();
  // Keyboard focus on a project row is the shell's inset outline, not the stock ring on top of it.
  // A programmatic `.focus()` only matches `:focus-visible` after a keyboard interaction, so the
  // Shift press switches the input modality before focusing.
  await userEvent.keyboard("{Shift}");
  picker.element().focus();
  expect(picker.element().matches(":focus-visible")).toBe(true);
  // The base button's `focus-visible:outline-hidden` already draws a 2 px transparent outline, so
  // the colour is what separates this row's inset focus from the stock ring.
  expect(getComputedStyle(picker.element()).outlineColor).toBe("rgb(118, 152, 253)");
  expect(getComputedStyle(picker.element()).boxShadow).not.toContain("inset");
  await picker.click();

  const selected = projects.element().querySelector<HTMLElement>("#settings-projects-selected");
  expect(selected?.textContent).toContain(project.name);
  expect(selected?.textContent).toContain(project.path);
  const branchRow = projects
    .element()
    .querySelector<HTMLElement>("#settings-project-branch-prefix");
  expect(branchRow?.textContent).toContain("Branch prefix");
  expect(branchRow?.textContent).toContain("app/");
  expect(branchRow?.querySelector(".settings-source")?.textContent).toBe("project");
  const agentRow = projects.element().querySelector<HTMLElement>("#settings-project-agent");
  expect(agentRow?.textContent).toContain("pi");
  expect(agentRow?.querySelector(".settings-source")?.textContent).toBe("inherited");

  await projects.getByRole("button", { name: "Change project" }).click();
  await projects.getByRole("button", { name: "Project settings for not-added" }).click();
  await expect.element(projects.getByText(/no added project has this path/)).toBeVisible();
  const unknownRow = projects
    .element()
    .querySelector<HTMLElement>("#settings-project-branch-prefix");
  expect(unknownRow?.textContent).toContain("nope/");
  expect(unknownRow?.querySelector(".settings-source")?.textContent).toBe("project");
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
    .toMatchTextContent(
      sequence("pi", "/nonexistent/pi", "global command", "not found", "chat driver"),
    );
  // Disabled in the file, found on the host, and shown as chat by this build's driver.
  await expect
    .element(agents)
    .toMatchTextContent(
      sequence("claude", "claude", "default command", "found", "chat driver", "disabled"),
    );
  // Every agent in this build has a chat driver.
  await expect
    .element(agents)
    .toMatchTextContent(sequence("codex", "codex", "default command", "found", "chat driver"));
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
  const defaults = await section("Defaults");
  await expect.element(defaults).toMatchTextContent(waiting);
  await expect.element(defaults).not.toMatchTextContent("Worktree root");
  await expect.element(await section("Naming")).toMatchTextContent(waiting);
  await expect.element(await section("Projects")).toMatchTextContent(waiting);

  const config = await section("Diagnostics");
  await expect.element(config).toMatchTextContent(waiting);
  await expect.element(config).not.toMatchTextContent("No problems");
  await expect.element(config).not.toMatchTextContent("has not been created");
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

    const config = await section("Diagnostics");
    const path = client.config.getSnapshot().path;
    await expect.element(config).toMatchTextContent(path);
    await expect.element(config).toMatchTextContent("never writes it");
    await expect.element(config).toMatchTextContent("The config file has not been created yet");
    await expect.element(config).toMatchTextContent("Corral applies the built-in defaults");
    await expect.element(config).not.toMatchTextContent("No problems");
    await expect.element(config.getByRole("button", { name: "Copy config path" })).toBeVisible();
    await config.getByRole("button", { name: "Copy config path" }).click();
    await expect.element(config).toMatchTextContent("Path copied");
    expect(clipboard.writeText).toHaveBeenLastCalledWith(path);

    await writeConfig('[tasks]\nagent = "pi"\n');
    await vi.waitFor(() => expect(client.config.getSnapshot().exists).toBe(true));
    await expect.element(config).toMatchTextContent("No problems");
    await expect.element(config).not.toMatchTextContent("has not been created");
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
        <DiagnosticsSection />
      </KeymapProvider>,
    );

    await expect.element(page.getByText("Existence unknown")).toBeVisible();
    await expect
      .element(page.getByText("This server does not report whether the config file exists"))
      .toBeVisible();
    await expect.element(page.getByText("No problems", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText(/has not been created/)).not.toBeInTheDocument();
    await expect.element(page.getByText(snapshot.path, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Copy config path" }).click();
    await expect.element(page.getByText("Path copied")).toBeVisible();
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

  const config = await section("Diagnostics");
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

  const profiles = await section("Profiles");
  await expect.element(profiles).toMatchTextContent("Live profile");
  await expect.element(profiles).toMatchTextContent("model and provider (model required)");
  await expect.element(profiles).not.toMatchTextContent("Claude gateway");
  await expect.element(await section("Diagnostics")).toMatchTextContent("No problems");
});

test("the sidebar entry opens settings; Escape and Back return to the same task with focus on the entry", async () => {
  const client = newClient();
  const { rendered } = await appWithTaskViaApi(client, "Settings trip");
  const terminal = document.querySelector(".terminal-host");

  await settingsButton().click();
  expect(document.querySelector(".terminal-host")).toBe(terminal);
  await expect.element(settingsHeading()).toBeVisible();
  // A plain open has no model target: Base UI keeps starting on the rail's Appearance button.
  await expect.element(settingsRailButton("Appearance")).toHaveFocus();

  // The mounted workspace is covered, not exposed: its terminal cannot take focus and AT
  // does not read it while settings is open.
  const workspaceLayer = document.querySelector(".visual-route-fill");
  expect(workspaceLayer?.closest("[inert]")).not.toBeNull();
  expect(workspaceLayer?.closest('[aria-hidden="true"]')).not.toBeNull();

  await userEvent.keyboard("{Escape}");
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /Settings trip/ }))
    .toHaveAttribute("aria-current", "true");
  await expect.element(settingsButton()).toHaveFocus();
  expect(document.querySelector(".visual-route-fill")?.closest("[inert]")).toBeNull();
  expect(document.querySelector(".visual-route-fill")?.closest('[aria-hidden="true"]')).toBeNull();

  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /Settings trip/ }))
    .toHaveAttribute("aria-current", "true");
  await expect.element(settingsButton()).toHaveFocus();

  // Clean history Back is the third close path and closes without a discard prompt.
  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  rendered.history.back();
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /Settings trip/ }))
    .toHaveAttribute("aria-current", "true");
  await expect.element(settingsButton()).toHaveFocus();
});

test("a dirty Models draft refuses X and Escape until Keep editing or Discard", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  const { rendered } = await appWithTaskViaApi(client, "Dirty settings");
  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await makeModelsDirty();

  // X / "Close settings": the confirm takes focus on Keep editing and the URL stays put.
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect.element(discardConfirm()).toBeVisible();
  await expect.element(discardConfirm()).toMatchTextContent("visibility and favorites");
  await expect
    .element(discardConfirm().getByRole("button", { name: "Keep editing", exact: true }))
    .toHaveFocus();
  expect(rendered.history.location.pathname).toBe("/settings");
  await discardConfirm().getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect.element(discardConfirm()).not.toBeInTheDocument();
  await expect.element(settingsHeading()).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Close settings" })).toHaveFocus();
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
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect.element(discardConfirm()).toBeVisible();
  await discardConfirm().getByRole("button", { name: "Discard and close", exact: true }).click();
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect.element(discardConfirm()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /Dirty settings/ }))
    .toHaveAttribute("aria-current", "true");
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

    await page.getByRole("button", { name: "Close settings" }).click();
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
  const { rendered } = await appWithTaskViaApi(client, "Keep this workspace");
  await prefixThen("t");
  await promptField().fill("Keep this unfinished prompt");
  const prompt = promptField().element();
  if (!(prompt instanceof HTMLTextAreaElement)) throw new Error("Prompt is not a textarea");
  prompt.setSelectionRange(5, 5);
  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await userEvent.keyboard("{Alt>}a{/Alt}");
  expect(document.querySelector('[aria-label="prefix mode"]')).toBeNull();
  await page.getByRole("combobox", { name: "Session tab position" }).click();
  await page.getByRole("option", { name: "Bottom", exact: true }).click();
  const scale = page.getByRole("slider", { name: "Interface text scale" });
  scale.element().focus();
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  await userEvent.keyboard("{Escape}");
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  expect(promptField().element()).toBe(prompt);
  expect(prompt.value).toBe("Keep this unfinished prompt");
  expect(prompt.selectionStart).toBe(5);
  expect(document.documentElement.style.fontSize).toBe("120%");
  expect(JSON.parse(window.localStorage.getItem("corral.appearance") ?? "{}")).toMatchObject({
    scale: 120,
    tabPosition: "bottom",
  });
  await rendered.unmount();
  await render(<App client={client} />);
  expect(document.documentElement.style.fontSize).toBe("120%");
});

test("the settings action is a configurable key, never a hardcoded chord", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await writeConfig('[keys.bindings]\nsettings = "z"\n');
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.keys.bindings["settings"]).toBe("z"),
  );

  await prefixThen("o");
  await expect.element(settingsHeading()).not.toBeInTheDocument();

  await prefixThen("z");
  await expect.element(settingsHeading()).toBeVisible();
  await expect.element(settingsRailButton("Appearance")).toHaveFocus();
  await expect.element(await section("Keyboard")).toMatchTextContent(/Settings\s*alt\+a z/);

  await userEvent.keyboard("{Escape}");
  await expect.element(settingsHeading()).not.toBeInTheDocument();
});

test("Settings has no visible header row and the section title carries the page", async () => {
  const client = newClient();
  await renderSettings(client);
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const heading = dialog.getByRole("heading", { name: "Settings", level: 1 });
  const header = heading.element().closest<HTMLElement>('[data-slot="dialog-header"]');
  expect(header?.className).toContain("sr-only");
  expect(header?.getBoundingClientRect().height).toBeLessThanOrEqual(1);
  await expect.element(dialog.getByRole("heading", { name: "Appearance", level: 2 })).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Close settings" })).toBeVisible();
});

test("the search field is a borderless Search field with a caret-only focus", async () => {
  const client = newClient();
  await renderSettings(client);
  const search = page.getByRole("combobox", { name: "Search settings" });
  await expect.element(search).toHaveAttribute("placeholder", "Search");
  const wrapper = search.element().closest(".settings-search");
  if (!(wrapper instanceof HTMLElement)) throw new Error("search wrapper missing");
  expect(getComputedStyle(wrapper).borderTopWidth).toBe("0px");
  // `frame="bare"` keeps the field's own border-0 and the row's 30 px height.
  expect(getComputedStyle(search.element()).borderTopWidth).toBe("0px");
  expect(getComputedStyle(search.element()).height).toBe("30px");
  await userEvent.keyboard("/");
  await expect.element(search).toHaveFocus();
  expect(getComputedStyle(search.element()).boxShadow).toBe("none");
  expect(getComputedStyle(search.element()).outlineStyle).toBe("none");
});

test("a pointer click leaves no focus ring, while Tab still shows one", async () => {
  const client = newClient();
  await renderSettings(client);
  // The dialog's enter animation moves every box inside it; let it settle before pointing.
  await vi.waitFor(() => expect(settingsDialog().element().getAnimations()).toHaveLength(0));
  const rowTitle = page.getByText("Interface text scale", { exact: true });
  await rowTitle.click();
  const row = rowTitle.element().closest<HTMLElement>(".settings-row");
  if (row === null) throw new Error("settings row missing");
  expect(document.activeElement).toBe(row);
  expect(row.matches(":focus-visible")).toBe(false);
  expect(getComputedStyle(row).outlineStyle).toBe("none");

  const position = page.getByRole("combobox", { name: "Session tab position" });
  await position.click();
  expect(getComputedStyle(position.element()).boxShadow).toBe("none");
  // The open popup owns Escape. Wait until it has finished opening, so its dismissal layer is
  // mounted before the key press, then check that only the popup closed.
  const option = page.getByRole("option", { name: "Bottom", exact: true });
  await expect.element(option).toBeVisible();
  const popup = document.querySelector<HTMLElement>('[data-slot="combobox-content"]');
  if (popup === null) throw new Error("the select popup did not open");
  await vi.waitFor(() => expect(popup.getAnimations({ subtree: true })).toHaveLength(0));
  await userEvent.keyboard("{Escape}");
  await expect.element(option).not.toBeInTheDocument();
  await expect.element(settingsHeading()).toBeVisible();

  const scale = page.getByRole("slider", { name: "Interface text scale" });
  await scale.click();
  expect(scale.element().matches(":focus-visible")).toBe(false);
  // A scale change re-lays out the dialog at once; its geometry never animates (`ui-kit.md`,
  // **Motion**), so no transition may start on it.
  expect(settingsDialog().element().getAnimations()).toHaveLength(0);

  const keyboard = settingsRailButton("Keyboard");
  await keyboard.click();
  expect(getComputedStyle(keyboard.element()).boxShadow).toBe("none");

  await userEvent.keyboard("{Tab}");
  const next = settingsRailButton("Defaults");
  await expect.element(next).toHaveFocus();
  expect(getComputedStyle(next.element()).boxShadow).not.toBe("none");
});

test("session tab position is a select row with Top and Bottom", async () => {
  const client = newClient();
  await renderSettings(client);
  const trigger = page.getByRole("combobox", { name: "Session tab position" });
  await expect.element(trigger).toHaveTextContent("Top");
  await expect
    .element(page.getByRole("radiogroup", { name: "Session tab position" }))
    .not.toBeInTheDocument();
  // The module owns the select's 160 px box; the kit trigger fills it.
  const box = trigger.element().closest<HTMLElement>(".settings-select");
  if (box === null) throw new Error("the select has no box");
  expect(getComputedStyle(box).width).toBe("160px");
  expect(trigger.element().getBoundingClientRect().width).toBeCloseTo(
    box.getBoundingClientRect().width,
  );
  await trigger.click();
  await page.getByRole("option", { name: "Bottom", exact: true }).click();
  await expect.element(trigger).toHaveTextContent("Bottom");
});

test("the text scale is a slider with a value box and a conditional reset", async () => {
  const client = newClient();
  await renderSettings(client);
  const reset = page.getByRole("button", { name: "Reset interface text scale to default" });
  await expect.element(reset).not.toBeInTheDocument();
  await expect.element(page.getByText("100%", { exact: true })).toBeVisible();
  const scale = page.getByRole("slider", { name: "Interface text scale" });
  scale.element().focus();
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  await expect.element(page.getByText("120%", { exact: true })).toBeVisible();
  await expect.element(reset).toBeVisible();
  expect(document.documentElement.style.fontSize).toBe("120%");
  await reset.click();
  await expect.element(page.getByText("100%", { exact: true })).toBeVisible();
  await expect.element(reset).not.toBeInTheDocument();
});

test("settings typography follows the interface text scale", async () => {
  const client = newClient();
  await renderSettings(client);
  const rowTitle = page.getByText("Interface text scale", { exact: true }).element();
  const navLabel = settingsRailButton("Appearance").element();
  expect(getComputedStyle(rowTitle).fontSize).toBe("13px");
  expect(getComputedStyle(navLabel).fontSize).toBe("14px");

  const scale = page.getByRole("slider", { name: "Interface text scale" });
  scale.element().focus();
  for (let step = 0; step < 4; step += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one real key press per step
    await userEvent.keyboard("{ArrowRight}");
  }
  await expect.element(page.getByText("140%", { exact: true })).toBeVisible();
  expect(document.documentElement.style.fontSize).toBe("140%");
  // The row and the nav label are the same roles at 140%: 13 × 1.4 and 14 × 1.4.
  await vi.waitFor(() => {
    expect(getComputedStyle(rowTitle).fontSize).toBe("18.2px");
    expect(getComputedStyle(navLabel).fontSize).toBe("19.6px");
  });

  await page.getByRole("button", { name: "Reset interface text scale to default" }).click();
  await vi.waitFor(() => {
    expect(getComputedStyle(rowTitle).fontSize).toBe("13px");
    expect(getComputedStyle(navLabel).fontSize).toBe("14px");
  });
});

test("one scrollbar recipe covers the settings column and its navigation", async () => {
  const original = { width: window.innerWidth, height: window.innerHeight };
  const client = newClient();
  try {
    await page.viewport(1024, 640);
    await renderSettings(client);
    const content = document.querySelector<HTMLElement>(".settings-content");
    const nav = document.querySelector<HTMLElement>(".settings-nav-scroll");
    if (content === null || nav === null) throw new Error("a settings scroller is missing");
    for (const scroller of [content, nav]) {
      expect(getComputedStyle(scroller, "::-webkit-scrollbar").width).toBe("8px");
      expect(getComputedStyle(scroller, "::-webkit-scrollbar-thumb").borderWidth).toBe("2px");
      // At rest the thumb is still there, low-contrast, so the lane is discoverable un-hovered.
      expect(getComputedStyle(scroller, "::-webkit-scrollbar-thumb").backgroundColor).not.toBe(
        "rgba(0, 0, 0, 0)",
      );
    }
  } finally {
    await page.viewport(original.width, original.height);
  }
});

test("a select row's popup opens at the trigger's width", async () => {
  const client = newClient();
  await renderSettings(client);
  const trigger = page.getByRole("combobox", { name: "Session tab position" });
  // The dialog's open animation scales everything; measure the settled trigger.
  await vi.waitFor(() => expect(trigger.element().getBoundingClientRect().width).toBeCloseTo(160));
  const width = trigger.element().getBoundingClientRect().width;
  await trigger.click();
  const popup = document.querySelector<HTMLElement>('[data-slot="combobox-content"]');
  if (popup === null) throw new Error("the select popup did not open");
  await vi.waitFor(() => expect(popup.getBoundingClientRect().width).toBeCloseTo(width, 0));
});

test("copy feedback clears, re-announces on a second copy, and does not survive a category change", async () => {
  const client = newClient();
  await writeConfig(null);
  const clipboard = stubClipboard(async () => undefined);
  try {
    await renderSettings(client);
    await vi.waitFor(() => expect(client.config.getSnapshot().exists).toBe(false));
    const config = await section("Diagnostics");
    const copy = config.getByRole("button", { name: "Copy config path" });
    await copy.click();
    await expect.element(config.getByText("Path copied", { exact: true })).toBeVisible();
    await vi.waitFor(
      () => expect(config.getByText("Path copied", { exact: true }).elements()).toHaveLength(0),
      { timeout: 2500 },
    );

    await copy.click();
    await expect.element(config.getByText("Path copied", { exact: true })).toBeVisible();
    await copy.click();
    await expect.element(config.getByText("Path copied", { exact: true })).toHaveLength(1);
    await settingsRailButton("Appearance").click();
    await settingsRailButton("Diagnostics").click();
    await expect.element(config.getByText("Path copied", { exact: true })).not.toBeInTheDocument();
  } finally {
    clipboard.restore();
  }
});

test("a refused config copy keeps the message and leaves the path keyboard-selectable", async () => {
  const client = newClient();
  await writeConfig(null);
  const clipboard = stubClipboard(async () => Promise.reject(new Error("denied")));
  try {
    await renderSettings(client);
    await vi.waitFor(() => expect(client.config.getSnapshot().exists).toBe(false));
    const config = await section("Diagnostics");
    await config.getByRole("button", { name: "Copy config path" }).click();
    await expect
      .element(config.getByRole("alert"))
      .toMatchTextContent("Copy is unavailable; select the path above");
    const path = config.getByText(client.config.getSnapshot().path, { exact: true });
    await expect.element(path).toBeVisible();
    expect(path.element().tabIndex).toBe(0);
    expect(path.element().getAttribute("aria-label")).toBe("Config file path");
    path.element().focus();
    await expect.element(path).toHaveFocus();
    await new Promise((resolve) => setTimeout(resolve, 1700));
    await expect.element(config.getByRole("alert")).toBeVisible();
    expect(path.element().tabIndex).toBe(0);
  } finally {
    clipboard.restore();
  }
});

test("the sidebar groups every section and `/` focuses search before Escape closes", async () => {
  const client = newClient();
  await renderSettings(client);
  const nav = page.getByRole("navigation", { name: "Settings categories" });
  await Promise.all(
    ["General", "Tasks", "Agents", "Models", "Code", "Diagnostics"].map(async (heading) => {
      await expect.element(nav.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }),
  );
  await vi.waitFor(() => expect(nav.element().getBoundingClientRect().width).toBeCloseTo(240, 0));

  const search = page.getByRole("combobox", { name: "Search settings" });
  await userEvent.keyboard("/");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("agent");
  await expect.element(search).toHaveValue("agent");
  // A slash inside the field is text, not another focus request.
  await userEvent.keyboard("/");
  await expect.element(search).toHaveValue("agent/");

  // The first Escape clears the query; the second reaches the dialog.
  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(settingsHeading()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(settingsHeading()).not.toBeInTheDocument();
});

test("a search result navigates to its row, clears the query and highlights it", async () => {
  const client = newClient();
  await renderSettings(client);
  const search = page.getByRole("combobox", { name: "Search settings" });
  await search.click();
  await userEvent.keyboard("worktree root");
  await expect.element(page.getByRole("listbox", { name: "Settings results" })).toBeVisible();
  await userEvent.keyboard("{Enter}");

  await expect.element(page.getByRole("region", { name: "Defaults" })).toBeVisible();
  await expect.element(search).toHaveValue("");
  const row = document.getElementById("settings-defaults-worktree-root");
  expect(row).not.toBeNull();
  await vi.waitFor(() => expect(row?.getAttribute("data-highlight")).toBe("true"));
  expect(document.activeElement).toBe(row);
});

test("keyboard search selection is painted and revealed at a short window", async () => {
  const original = { width: window.innerWidth, height: window.innerHeight };
  const client = newClient();
  try {
    await page.viewport(1024, 640);
    await renderSettings(client);
    const search = page.getByRole("combobox", { name: "Search settings" });
    await search.click();
    await userEvent.keyboard("a");
    await expect.element(page.getByRole("listbox", { name: "Settings results" })).toBeVisible();
    const options = page.getByRole("option").elements().length;
    expect(options).toBeGreaterThan(12);

    // Moving the highlight with the arrows lands the selection in the visible part of the rail.
    for (let step = 0; step < 12; step += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one real key press per step
      await userEvent.keyboard("{ArrowDown}");
    }
    const scroller = document.querySelector<HTMLElement>(".settings-nav-scroll");
    if (scroller === null) throw new Error("no settings navigation scroller");
    const selected = document.querySelector<HTMLElement>('.settings-result[aria-selected="true"]');
    if (selected === null) throw new Error("no selected search result");
    const row = selected.getBoundingClientRect();
    const visible = scroller.getBoundingClientRect();
    expect(row.top).toBeGreaterThanOrEqual(visible.top - 1);
    expect(row.bottom).toBeLessThanOrEqual(visible.bottom + 1);

    // The option hands the highlight down to its row as `data-highlighted`; the button paints it.
    const button = selected.querySelector<HTMLElement>('[data-slot="button"]');
    if (button === null) throw new Error("the selected result has no button");
    expect(getComputedStyle(button).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  } finally {
    await page.viewport(original.width, original.height);
  }
});

test("an empty search says No settings found in one row", async () => {
  const client = newClient();
  await renderSettings(client);
  const search = page.getByRole("combobox", { name: "Search settings" });
  await search.fill("no such setting");
  await expect.element(page.getByText("No settings found", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("listbox", { name: "Settings results" }))
    .not.toBeInTheDocument();
});

test("each section keeps its own scroll offset while the dialog stays open", async () => {
  const client = newClient();
  await renderSettings(client);
  await section("Keyboard");
  const content = document.querySelector<HTMLElement>(".settings-content");
  if (content === null) throw new Error("no settings scroller");
  content.scrollTop = content.scrollHeight;
  const saved = content.scrollTop;
  expect(saved).toBeGreaterThan(0);

  await settingsRailButton("Appearance").click();
  await settingsRailButton("Keyboard").click();
  await vi.waitFor(() => expect(content.scrollTop).toBe(saved));
});

test("the dialog never scrolls: the content column is its one inset scroller", async () => {
  const original = { width: window.innerWidth, height: window.innerHeight };
  const client = newClient();
  try {
    await page.viewport(1024, 640);
    await renderSettings(client);
    await section("Models");
    const dialog = settingsDialog().element();
    const content = document.querySelector<HTMLElement>(".settings-content");
    if (content === null) throw new Error("no settings scroller");
    // The open animation scales the popup; measure its settled box.
    await vi.waitFor(() => expect(dialog.getAnimations({ subtree: true })).toHaveLength(0));

    // At the 1024x640 minimum window the Models page is taller than the column.
    await vi.waitFor(() => expect(content.scrollHeight).toBeGreaterThan(content.clientHeight));
    expect(dialog.scrollHeight).toBeLessThanOrEqual(dialog.clientHeight);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(
      document.documentElement.clientHeight,
    );
    // Nothing between the dialog and the column takes over the scroll.
    for (
      let wrapper = content.parentElement;
      wrapper !== null && wrapper !== dialog;
      wrapper = wrapper.parentElement
    ) {
      expect(wrapper.scrollHeight).toBeLessThanOrEqual(wrapper.clientHeight);
    }

    // The column carries the kit's bar: an 8 px lane with the 2 px inset pill thumb, held off the
    // dialog's rounded edge instead of sitting on it.
    expect(getComputedStyle(content, "::-webkit-scrollbar").width).toBe("8px");
    expect(getComputedStyle(content, "::-webkit-scrollbar-thumb").borderWidth).toBe("2px");
    expect(
      dialog.getBoundingClientRect().right - content.getBoundingClientRect().right,
    ).toBeGreaterThanOrEqual(8);

    // A wheel over the page moves the column and nothing else.
    const heading = page
      .getByRole("region", { name: "Models", exact: true })
      .getByRole("heading", { name: "Models" });
    await userEvent.wheel(heading, { delta: { y: 120 } });
    await vi.waitFor(() => expect(content.scrollTop).toBeGreaterThan(0));
    expect(dialog.scrollTop).toBe(0);
    expect(window.scrollY).toBe(0);

    // On a tall window the Models page fits the column, so nothing scrolls at all there.
    await page.viewport(1920, 1080);
    await vi.waitFor(() => expect(dialog.getBoundingClientRect().height).toBeGreaterThan(900));
    expect(content.scrollHeight).toBeLessThanOrEqual(content.clientHeight);
    expect(dialog.scrollHeight).toBeLessThanOrEqual(dialog.clientHeight);
  } finally {
    await page.viewport(original.width, original.height);
  }
});

test("a project target opens Projects with that project selected", async () => {
  const client = newClient();
  await connected(client);
  const repo = await createGitRepo("repo");
  const project = await client.connection.api.projects.add({ path: repo });
  await render(
    <App
      client={client}
      initialEntries={[`/settings?settingsProject=${encodeURIComponent(project.path)}`]}
    />,
  );
  await expect.element(settingsHeading()).toBeVisible();
  const projects = page.getByRole("region", { name: "Projects" });
  await expect.element(projects).toBeVisible();
  const selected = projects.element().querySelector<HTMLElement>("#settings-projects-selected");
  expect(selected?.textContent).toContain(project.name);
  expect(selected?.textContent).toContain(project.path);
  expect(
    projects
      .element()
      .querySelector<HTMLElement>("#settings-project-branch-prefix")
      ?.querySelector(".settings-source")?.textContent,
  ).toBe("inherited");
});
