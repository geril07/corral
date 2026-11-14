import { defaultModelPolicy, modelScopeKey, type ModelPreferences } from "@corral/protocol/models";
import type { CorralClient } from "@corral/client/corral-client";
import { Store } from "@corral/client/store";
import type { WatchFailure, WatchStore } from "@corral/client/watch-store";
import { taskSettingsFor } from "@corral/protocol/config";
import type { Session } from "@corral/protocol/rpc";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { ChatChoiceDialog, ChatView, chatTranscriptStore } from "../chat/index.ts";
import { Button } from "../../common/ui/index.ts";
import { SettingsScreen } from "./settings-screen.tsx";
import { AppProviders } from "../../../src/app/providers.tsx";
import { renderApp } from "../../../test/render-app.tsx";
import { createGitRepo } from "../../../test/git-repo.ts";
import { writeFilesIn } from "../../../test/files-client.ts";
import { runGitIn } from "../../../test/git-client.ts";
import { realServerClients, prefixThen } from "../../../test/real-client.ts";
import { writeConfig } from "../../../test/config-command.ts";
import { projectOptionLabel } from "../projects/index.ts";
import { promptField } from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const scope = { kind: "pi" as const, profileId: null };

/** The shell has no Add-project dialog; the API registers the repository and the app reads it. */
async function appWithProject(client: ReturnType<typeof newClient>) {
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  const repo = await createGitRepo("repo");
  const project = await client.connection.api.projects.add({ path: repo });
  const rendered = await renderApp(client);
  await expect.poll(() => client.projects.getSnapshot().loaded).toBe(true);
  return { client, repo, project, rendered };
}
const settings = () => page.getByRole("dialog", { name: "Settings", exact: true });
const settingsEntry = () => page.getByRole("button", { name: "Settings", exact: true });
const settingsCategories = () =>
  settings().getByRole("navigation", { name: "Settings categories" });
const models = () => page.getByRole("region", { name: "Models", exact: true });
const checkbox = (name: string) => models().getByRole("checkbox", { name, exact: true });

interface PreferencesSnapshot {
  loaded: boolean;
  items: readonly ModelPreferences[];
}

interface FakePreferences {
  store: WatchStore<PreferencesSnapshot>;
  set(value: PreferencesSnapshot): void;
  fail(failure: WatchFailure | undefined): void;
  retries(): number;
}

/**
 * A preferences watch whose snapshot and refusal the test decides. Retry clears the refusal and
 * waits for `set` or `fail`, so the test can hold and inspect the retrying interval. It counts
 * every call, so a repeated UI activation is caught rather than hidden by a fake guard.
 */
function fakePreferences(initial: PreferencesSnapshot): FakePreferences {
  const snapshot = new Store(initial);
  const failure = new Store<WatchFailure | undefined>(undefined);
  let retries = 0;
  return {
    store: {
      subscribe: snapshot.subscribe,
      getSnapshot: snapshot.getSnapshot,
      failure: { subscribe: failure.subscribe, getSnapshot: failure.getSnapshot },
      retry: () => {
        retries += 1;
        failure.set(undefined);
      },
      close: () => {},
    },
    set: (value) => snapshot.set(value),
    fail: (value) => failure.set(value),
    retries: () => retries,
  };
}

/** Installs the fake before Settings mounts, so its Models section reads the fake watch. */
function installPreferences(client: ReturnType<typeof newClient>, preferences: FakePreferences) {
  Object.defineProperty(client, "modelPreferences", {
    configurable: true,
    value: preferences.store,
  });
}

const NO_FILES = {
  resolve: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("this chat has no local file links")),
  open: () => Promise.resolve(),
};

/**
 * The shared live-chat surface without the routed shell, which does not mount chat yet: the
 * production `ChatView`, its model button and the `ChatChoiceDialog` it opens, wired the way the
 * workspace owns them. Settings is the routed Models section, not a panel owned by the picker.
 */
function LiveChat({
  client,
  taskId,
  session,
  projectPath,
}: {
  client: CorralClient;
  taskId: string;
  session: Session;
  projectPath: string;
}) {
  const config = useSyncExternalStore(client.config.subscribe, client.config.getSnapshot);
  const chat = useMemo(() => client.openChat(session.id), [client, session.id]);
  useEffect(() => () => chat.close(), [chat]);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<"model" | "reasoning">();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [memory] = useState(chatTranscriptStore);
  return (
    <AppProviders client={client}>
      <div className="h-screen w-full">
        <ChatView
          store={chat}
          memory={memory}
          draft={draft}
          onDraftChange={setDraft}
          agent={session.kind === "shell" ? "pi" : session.kind}
          followUp={undefined}
          canChooseAgent
          modelPickerAnchor={anchor}
          onSend={async (text, mode) => {
            await client.connection.api.chat.send({ sessionId: session.id, text, mode });
          }}
          aborting={false}
          onAbort={async () => {
            await client.connection.api.chat.abort({ sessionId: session.id });
          }}
          onRespond={async (requestId, value) => {
            await client.connection.api.chat.respond({ sessionId: session.id, requestId, value });
          }}
          onChangeModel={() => setKind("model")}
          onChangeReasoning={() => setKind("reasoning")}
          files={NO_FILES}
        />
      </div>
      {kind !== undefined && (
        <ChatChoiceDialog
          context={{ taskId }}
          store={chat}
          kind={kind}
          agent={session.kind === "shell" ? "pi" : session.kind}
          launch={session.launch}
          profiles={config.profiles}
          agents={config.config.agents}
          settings={taskSettingsFor(config.config, projectPath)}
          chatDrivers={["pi"]}
          anchor={anchor}
          onSetModel={async (model) => {
            await client.connection.api.chat.setModel({ sessionId: session.id, model });
          }}
          onSetReasoning={async (level) => {
            await client.connection.api.chat.setReasoning({ sessionId: session.id, level });
          }}
          onStart={() => Promise.resolve()}
          onClose={() => setKind(undefined)}
        />
      )}
      <Button type="button" variant="ghost" onClick={() => setSettingsOpen(true)}>
        Settings
      </Button>
      {settingsOpen && <SettingsScreen onClose={() => setSettingsOpen(false)} />}
    </AppProviders>
  );
}

const saveButton = () => models().getByRole("button", { name: "Save", exact: true });
const savedStatus = () => models().getByRole("status").filter({ hasText: "Saved · revision" });
const unsavedStatus = () => models().getByRole("status").filter({ hasText: "Unsaved changes" });
const savingStatus = () => models().getByRole("status").filter({ hasText: "Saving…" });
const unavailableStatus = () =>
  models().getByRole("status").filter({ hasText: "Preferences unavailable" });
const loadingStatus = () =>
  models().getByRole("status").filter({ hasText: "Loading preferences…" });
const findModels = () => models().getByRole("textbox", { name: "Find models" });
const configuredDefault = () => models().getByText("Configured default", { exact: true });
const hiddenConfiguredDefault = () =>
  models().getByText(
    "The configured default is hidden by this draft's model filter; it is not changed.",
    { exact: true },
  );
const workspaceSelect = () =>
  models().getByRole("combobox", { name: "Catalog workspace", exact: true });
const modelRow = (name: string) => models().getByRole("group", { name, exact: true });
const configuredDefaultIn = (name: string) =>
  modelRow(name).getByText("Configured default", { exact: true });

async function chooseWorkspace(name: string) {
  await workspaceSelect().click();
  await page.getByRole("option", { name, exact: true }).click();
}

/** A real git repository whose directory name is `name`, so two projects can share a display name. */
async function addNamedProject(client: ReturnType<typeof newClient>, name: string) {
  const holder = await createGitRepo(`holder-${name}`);
  const path = `${holder}/${name}`;
  await writeFilesIn(holder, { [`${name}/README.md`]: "hello\n" });
  await runGitIn(path, ["init", "-b", "main"]);
  await runGitIn(path, ["add", "."]);
  await runGitIn(path, ["commit", "-m", "initial commit"]);
  const project = await client.connection.api.projects.add({ path });
  await vi.waitFor(() =>
    expect(client.projects.getSnapshot().projects.some((each) => each.id === project.id)).toBe(
      true,
    ),
  );
  return project;
}

async function expectMarked(name: string) {
  await expect.element(configuredDefaultIn(name)).toBeVisible();
  await expect.element(configuredDefault()).toHaveLength(1);
}

async function expectNotMarked(name: string) {
  await expect.element(configuredDefaultIn(name)).not.toBeInTheDocument();
}

async function openManager(
  options: {
    config?: string;
    beforeManage?: (client: ReturnType<typeof newClient>) => void;
  } = {},
) {
  const client = newClient();
  await writeConfig(options.config ?? '[tasks]\nagent = "pi"\n');
  const { rendered, repo } = await appWithProject(client);
  await prefixThen("t");
  await promptField().fill("Keep this prompt and selection");
  const composer = promptField().element();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  options.beforeManage?.(client);
  await settingsEntry().click();
  await expect.element(settings()).toBeVisible();
  await settingsCategories().getByRole("button", { name: "Models", exact: true }).click();
  await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  return { client, composer, rendered, repo };
}

/** Holds the next models.catalog until the test releases it, then runs the real probe. */
function holdNextCatalog(client: ReturnType<typeof newClient>) {
  const api = client.connection.api;
  const catalog = api.models.catalog;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gatedModels = new Proxy(api.models, {
    get(target, property, receiver) {
      if (property === "catalog")
        return async (input: Parameters<typeof catalog>[0]) => {
          await gate;
          return catalog(input);
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

/** Holds the next models.save until the test releases it, then saves. */
function holdNextSave(client: ReturnType<typeof newClient>) {
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

const rail = () => settings().getByRole("navigation", { name: "Settings categories" });
const railButton = (name: string) => rail().getByRole("button", { name, exact: true });
const firstModelControl = () =>
  models().getByRole("combobox", { name: "Model tool/profile", exact: true });

test("Settings opens the Models panel and keeps the keyboard inside it at 1024 and 1920", async () => {
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  try {
    await page.viewport(1024, 640);
    await openManager();
    await expect.element(firstModelControl()).toBeVisible();
    expect(models().element().contains(document.activeElement)).toBe(false);

    firstModelControl().element().focus();
    await expect.element(firstModelControl()).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    expect(models().element().contains(document.activeElement)).toBe(true);

    // The reported bug: Enter reached the rail's Appearance button and left Models.
    firstModelControl().element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(models()).toBeVisible();
    await expect.element(railButton("Models")).toHaveAttribute("aria-current", "page");
    await expect
      .element(page.getByRole("region", { name: "Appearance", exact: true }))
      .not.toBeInTheDocument();

    await settings().getByRole("button", { name: "Close settings" }).click();
    await expect.element(settings()).not.toBeInTheDocument();
    await page.viewport(1920, 1080);
    await settingsEntry().click();
    await expect.element(settings()).toBeVisible();
    await railButton("Models").click();
    await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});

test("the shared manager saves an exact whitelist and returns to the composer draft", async () => {
  const { client, composer } = await openManager();
  const peer = newClient();
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  await expect
    .element(checkbox("Show provider stub including future models"))
    .toHaveAttribute("aria-checked", "mixed");
  await models().getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() =>
    expect(
      peer.modelPreferences
        .getSnapshot()
        .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope))?.policy.allow,
    ).toEqual([{ type: "model", provider: "stub", id: "stub-2" }]),
  );
  await settings().getByRole("button", { name: "Close settings" }).click();
  await expect.element(settings()).not.toBeInTheDocument();
  expect(promptField().element()).toBe(composer);
  await expect.element(promptField()).toHaveValue("Keep this prompt and selection");
  await expect.element(settingsEntry()).toHaveFocus();
  await vi.waitFor(() => expect(client.tasks.getSnapshot().tasks).toHaveLength(0));
});

test("the configured default is marked at Server home; hiding it warns once and still saves", async () => {
  const { client } = await openManager({
    config: '[tasks]\nagent = "pi"\nmodel = "stub-1"\n',
  });
  await chooseWorkspace("Server home");
  await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  await expect.element(checkbox("Show Stub One · stub")).toBeChecked();
  await expectMarked("Stub One · stub");
  await expect.element(hiddenConfiguredDefault()).not.toBeInTheDocument();

  await checkbox("Show Stub One · stub").click();
  await expect.element(checkbox("Show Stub One · stub")).not.toBeChecked();
  await expect.element(hiddenConfiguredDefault()).toHaveLength(1);
  await expect.element(saveButton()).toBeEnabled();
  await saveButton().click();
  await expect.element(savedStatus()).toMatchTextContent(/Saved · revision/);
  await expect.element(hiddenConfiguredDefault()).not.toBeInTheDocument();
  await expectMarked("Stub One · stub");
  await vi.waitFor(() =>
    expect(
      client.modelPreferences
        .getSnapshot()
        .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope))?.policy.deny,
    ).toEqual([{ type: "model", provider: "stub", id: "stub-1" }]),
  );

  // The configured default is still the marked row, not a footer action.
  await settings().getByRole("button", { name: "Close settings" }).click();
  await expect.element(settings()).not.toBeInTheDocument();
});

test("a project override moves the configured default with the selected catalog workspace", async () => {
  const { client, repo } = await openManager({
    config: '[tasks]\nagent = "pi"\nmodel = "stub-1"\n',
  });
  await expectMarked("Stub One · stub");

  await writeConfig(
    `[tasks]\nagent = "pi"\nmodel = "stub-1"\n\n[projects."${repo}"]\nmodel = "stub-2"\n`,
  );
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[repo]?.model.value).toBe("stub-2"),
  );
  // Settings starts at Server home, so the global default is still the marked row.
  await expectMarked("Stub One · stub");

  const project = client.projects.getSnapshot().projects.find((each) => each.path === repo)!;
  await chooseWorkspace(projectOptionLabel(project));
  await expect.element(checkbox("Show Stub Two · stub")).toBeVisible();
  await expectMarked("Stub Two · stub");
  await expectNotMarked("Stub One · stub");

  await chooseWorkspace("Server home");
  await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  await expectMarked("Stub One · stub");
  await expectNotMarked("Stub Two · stub");
});

test("same-named catalog workspaces read by path, filter by name and path, and drive discovery", async () => {
  const { client } = await openManager({
    config: '[tasks]\nagent = "pi"\nmodel = "stub-1"\n',
  });
  const first = await addNamedProject(client, "dup");
  const second = await addNamedProject(client, "dup");
  await writeConfig(
    `[tasks]\nagent = "pi"\nmodel = "stub-1"\n\n[projects."${first.path}"]\nmodel = "stub-2"\n`,
  );
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[first.path]?.model.value).toBe("stub-2"),
  );

  await workspaceSelect().click();
  const search = page.getByRole("combobox", { name: "Search workspaces", exact: true });
  const firstOption = page.getByRole("option", {
    name: projectOptionLabel(first),
    exact: true,
  });
  const secondOption = page.getByRole("option", {
    name: projectOptionLabel(second),
    exact: true,
  });
  await expect.element(firstOption).toBeVisible();
  await expect.element(secondOption).toBeVisible();
  // The path column keeps the distinguishing tail, not only the common prefix.
  expect(firstOption.element().textContent).not.toBe(secondOption.element().textContent);
  expect(firstOption.element().getAttribute("aria-label")).toBe(`${first.name} ${first.path}`);
  expect(secondOption.element().getAttribute("aria-label")).toBe(`${second.name} ${second.path}`);

  // The shared name matches both; each full path matches only its own project.
  await search.fill("dup");
  await expect.element(firstOption).toBeVisible();
  await expect.element(secondOption).toBeVisible();
  await search.fill(first.path);
  await expect.element(firstOption).toBeVisible();
  await expect.element(secondOption).not.toBeInTheDocument();
  await search.fill("no-such-workspace");
  await expect.element(firstOption).not.toBeInTheDocument();
  await expect.element(secondOption).not.toBeInTheDocument();
  await search.fill("");

  await firstOption.click();
  await expect.element(workspaceSelect()).toHaveTextContent(first.name);
  await expectMarked("Stub Two · stub");
  await expectNotMarked("Stub One · stub");

  await workspaceSelect().click();
  await page.getByRole("combobox", { name: "Search workspaces", exact: true }).fill(second.path);
  await secondOption.click();
  await expect.element(workspaceSelect()).toHaveTextContent(second.name);
  await expectMarked("Stub One · stub");
  await expectNotMarked("Stub Two · stub");
});

test("a long catalog workspace keeps the trigger bounded and the list inside Settings at 1024x640/140%", async () => {
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  const previousScale = document.documentElement.style.fontSize;
  try {
    await page.viewport(1024, 640);
    const { client } = await openManager();
    const long = await addNamedProject(client, `workspace-${"L".repeat(60)}`);
    document.documentElement.style.fontSize = "140%";

    await workspaceSelect().click();
    const search = page.getByRole("combobox", { name: "Search workspaces", exact: true });
    await search.fill(long.path);
    const option = page.getByRole("option", {
      name: projectOptionLabel(long),
      exact: true,
    });
    await expect.element(option).toBeVisible();
    await vi.waitFor(() => {
      const titles = [...option.element().querySelectorAll("[title]")].map((each) =>
        each.getAttribute("title"),
      );
      expect(titles).toContain(long.path);
    });
    await option.click();

    const trigger = workspaceSelect().element();
    await vi.waitFor(() =>
      expect(trigger.querySelector("[title]")?.getAttribute("title")).toBe(long.name),
    );
    const triggerLimit =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 16;
    expect(trigger.getBoundingClientRect().width).toBeLessThanOrEqual(triggerLimit + 0.5);

    await workspaceSelect().click();
    expect(models().element().scrollWidth).toBeLessThanOrEqual(models().element().clientWidth);
    expect(settings().element().scrollWidth).toBeLessThanOrEqual(settings().element().clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
  } finally {
    document.documentElement.style.fontSize = previousScale;
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});

test("a different catalog-backed agent scope marks nothing rather than matching by id", async () => {
  await openManager({ config: '[tasks]\nagent = "pi"\nmodel = "stub-1"\n' });
  await expectMarked("Stub One · stub");

  await firstModelControl().click();
  await page.getByRole("option", { name: "opencode · opencode", exact: true }).click();
  await expect.element(checkbox("Show Stub Model · stub")).toBeVisible();
  await expect.element(configuredDefault()).not.toBeInTheDocument();
  await expectNotMarked("Stub Model · stub");

  await firstModelControl().click();
  await page.getByRole("option", { name: "pi · pi", exact: true }).click();
  await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  await expectMarked("Stub One · stub");
});

test("the configured default mark appears when a held catalog finishes loading", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\nmodel = "stub-1"\n');
  await appWithProject(client);
  const { release } = holdNextCatalog(client);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect.element(settings()).toBeVisible();
  await settings()
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Models", exact: true })
    .click();
  await expect
    .element(models().getByRole("status").filter({ hasText: "Loading native models…" }))
    .toBeVisible();
  await expect.element(configuredDefault()).not.toBeInTheDocument();
  await expect.element(checkbox("Show Stub One · stub")).not.toBeInTheDocument();

  release();
  await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  await expectMarked("Stub One · stub");
});

test("hiding a live model keeps its session, thinking, draft and composer node; other clients can reveal it again", async () => {
  const client = newClient();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  const repo = await createGitRepo("live-model");
  const project = await client.connection.api.projects.add({ path: repo });
  const task = await client.connection.api.tasks.create({
    title: "Model visibility",
    projectId: project.id,
    workspace: { type: "main-worktree" },
  });
  const session = await client.connection.api.sessions.start({
    taskId: task.id,
    kind: "pi",
    view: "chat",
    size: { cols: 80, rows: 24 },
  });
  const screen = await render(
    <LiveChat client={client} taskId={task.id} session={session} projectPath={repo} />,
  );
  try {
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect
      .element(page.getByRole("button", { name: "Model Stub One", exact: true }))
      .toBeVisible();
    await message.fill("An independent live draft");
    const composer = message.element();
    // Settings is its own route now; the chat picker is closed while it is open.
    await page.getByRole("button", { name: "Model Stub One", exact: true }).click();
    const live = page.getByRole("dialog", { name: "Chat model", exact: true });
    await userEvent.keyboard("{Escape}");
    await expect.element(live).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect.element(settings()).toBeVisible();
    await settingsCategories().getByRole("button", { name: "Models", exact: true }).click();
    await checkbox("Show provider stub including future models").click();
    await models().getByRole("button", { name: "Save", exact: true }).click();
    await expect.element(models().getByText("Saved ·", { exact: false })).toBeVisible();
    await settings().getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Model Stub One", exact: true }).click();
    await expect.element(live).toBeVisible();
    expect(live.element().querySelectorAll("p")).toHaveLength(0);
    await expect.element(live.getByRole("option", { name: /Stub Two/ })).not.toBeInTheDocument();
    await expect.element(live.getByRole("option", { name: /Stub One/ })).toBeDisabled();

    const chat = client.openChat(session.id);
    try {
      await vi.waitFor(() => expect(chat.getSnapshot().state.model?.id).toBe("stub-1"));
      expect(chat.getSnapshot().state.reasoning).toBe("medium");
      const peer = newClient();
      await vi.waitFor(() => expect(peer.modelPreferences.getSnapshot().loaded).toBe(true));
      const prefs = peer.modelPreferences
        .getSnapshot()
        .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope))!;
      await peer.connection.api.models.save({ ...prefs, policy: defaultModelPolicy() });
      await expect.element(live.getByRole("option", { name: /Stub Two/ })).toBeVisible();
    } finally {
      chat.close();
    }

    await userEvent.keyboard("{Escape}");
    expect(message.element()).toBe(composer);
    await expect.element(message).toHaveValue("An independent live draft");
    await expect.element(message).toHaveFocus();
    expect(client.sessions.getSnapshot().sessions.filter((s) => s.taskId === task.id)).toHaveLength(
      1,
    );
  } finally {
    await screen.unmount();
  }
});

test("a refused preferences watch stays retryable, then returns focus to the footer when it loads", async () => {
  const recovered: PreferencesSnapshot = {
    loaded: true,
    items: [
      {
        scope,
        revision: 4,
        policy: {
          ...defaultModelPolicy(),
          deny: [{ type: "model", provider: "stub", id: "stub-2" }],
        },
      },
    ],
  };
  const preferences = fakePreferences({ loaded: false, items: [] });
  await openManager({
    beforeManage: (client) => {
      installPreferences(client, preferences);
      preferences.fail({
        name: "models.watch",
        label: "model preferences",
        error: new Error("no such procedure"),
      });
    },
  });
  const note = models().getByRole("note");
  await expect.element(note).toMatchTextContent("Model preferences did not load");
  const retry = models().getByRole("button", { name: "Retry", exact: true });
  await expect.element(retry).toBeVisible();
  await expect.element(unavailableStatus()).toHaveTextContent("Preferences unavailable");
  await expect.element(savedStatus()).not.toBeInTheDocument();
  await expect.element(checkbox("Show Stub One · stub")).toBeDisabled();

  retry.element().focus();
  await expect.element(retry).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(preferences.retries()).toBe(1);
  // The notice and its control stay mounted while the watch answers. The fake counts every call,
  // so a second activation reaching it would make this assertion fail.
  await expect.element(note).toMatchTextContent("Retrying model preferences");
  await expect.element(note).toHaveAttribute("aria-busy", "true");
  await expect.element(loadingStatus()).toHaveTextContent("Loading preferences…");
  await expect.element(unavailableStatus()).not.toBeInTheDocument();
  await retry.click();
  expect(preferences.retries()).toBe(1);
  await expect.element(retry).toHaveFocus();

  preferences.set(recovered);
  await expect.element(note).not.toBeInTheDocument();
  await expect.element(savedStatus()).toHaveTextContent("Saved · revision 4");
  await expect.element(savedStatus()).toHaveFocus();
  await expect.element(checkbox("Show Stub One · stub")).toBeEnabled();
  await expect.element(checkbox("Show Stub Two · stub")).not.toBeChecked();
});

test("a retry that fails again keeps Retry focused, and a reopened panel still names the refusal", async () => {
  const preferences = fakePreferences({ loaded: false, items: [] });
  await openManager({
    beforeManage: (client) => {
      installPreferences(client, preferences);
      preferences.fail({
        name: "models.watch",
        label: "model preferences",
        error: new Error("no such procedure"),
      });
    },
  });
  const note = models().getByRole("note");
  const retry = models().getByRole("button", { name: "Retry", exact: true });
  await expect.element(note).toMatchTextContent("Model preferences did not load");
  retry.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(preferences.retries()).toBe(1);
  await expect.element(note).toMatchTextContent("Retrying model preferences");

  preferences.fail({
    name: "models.watch",
    label: "model preferences",
    error: new Error("still refused"),
  });
  await expect.element(note).toMatchTextContent("Model preferences did not load");
  await expect.element(unavailableStatus()).toHaveTextContent("Preferences unavailable");
  await expect.element(retry).toHaveFocus();

  await settings().getByRole("button", { name: "Close settings" }).click();
  await expect.element(settings()).not.toBeInTheDocument();
  await settingsEntry().click();
  await expect.element(settings()).toBeVisible();
  await settingsCategories().getByRole("button", { name: "Models", exact: true }).click();
  await expect.element(note).toMatchTextContent("Model preferences did not load");
  await expect.element(retry).toBeVisible();
  await expect.element(unavailableStatus()).toHaveTextContent("Preferences unavailable");
});

test("a loaded refusal stays mounted through Retry and a failed retry restores Retry focus", async () => {
  const preferences = fakePreferences({
    loaded: true,
    items: [{ scope, revision: 2, policy: defaultModelPolicy() }],
  });
  await openManager({
    beforeManage: (client) => installPreferences(client, preferences),
  });
  await expect.element(savedStatus()).toHaveTextContent("Saved · revision 2");
  preferences.fail({
    name: "models.watch",
    label: "model preferences",
    error: new Error("watch ended"),
  });
  const note = models().getByRole("note");
  const retry = models().getByRole("button", { name: "Retry", exact: true });
  await expect.element(note).toMatchTextContent("Model preferences stopped updating");

  retry.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(preferences.retries()).toBe(1);
  await expect.element(note).toMatchTextContent("Retrying model preferences");
  await expect.element(note).toHaveAttribute("aria-busy", "true");
  await expect.element(savedStatus()).toHaveTextContent("Saved · revision 2");
  await expect.element(retry).toHaveFocus();

  preferences.fail({
    name: "models.watch",
    label: "model preferences",
    error: new Error("still refused"),
  });
  await expect.element(note).toMatchTextContent("Model preferences stopped updating");
  await expect.element(note).not.toHaveAttribute("aria-busy", "true");
  await expect.element(retry).toHaveFocus();
  await expect.element(savedStatus()).toHaveTextContent("Saved · revision 2");
});

test("a slow retry leaves focus where the user moved it", async () => {
  const preferences = fakePreferences({
    loaded: true,
    items: [{ scope, revision: 2, policy: defaultModelPolicy() }],
  });
  await openManager({
    beforeManage: (client) => installPreferences(client, preferences),
  });
  await expect.element(savedStatus()).toHaveTextContent("Saved · revision 2");
  preferences.fail({
    name: "models.watch",
    label: "model preferences",
    error: new Error("watch ended"),
  });
  const note = models().getByRole("note");
  const retry = models().getByRole("button", { name: "Retry", exact: true });
  await expect.element(note).toMatchTextContent("Model preferences stopped updating");

  retry.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(note).toMatchTextContent("Retrying model preferences");
  findModels().element().focus();
  await expect.element(findModels()).toHaveFocus();
  preferences.fail({
    name: "models.watch",
    label: "model preferences",
    error: new Error("still refused"),
  });
  await expect.element(note).toMatchTextContent("Model preferences stopped updating");
  await expect.element(findModels()).toHaveFocus();

  await retry.click();
  await expect.element(note).toMatchTextContent("Retrying model preferences");
  findModels().element().focus();
  await expect.element(findModels()).toHaveFocus();
  preferences.set({
    loaded: true,
    items: [{ scope, revision: 3, policy: defaultModelPolicy() }],
  });
  await expect.element(note).not.toBeInTheDocument();
  await expect.element(findModels()).toHaveFocus();
  await expect.element(savedStatus()).toHaveTextContent("Saved · revision 3");
});

test("a retry that returns a newer revision keeps the dirty draft and shows the stale conflict", async () => {
  const loaded: PreferencesSnapshot = {
    loaded: true,
    items: [{ scope, revision: 2, policy: defaultModelPolicy() }],
  };
  const preferences = fakePreferences(loaded);
  await openManager({
    beforeManage: (client) => installPreferences(client, preferences),
  });
  await expect.element(savedStatus()).toHaveTextContent("Saved · revision 2");
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  await expect.element(unsavedStatus()).toHaveTextContent("Unsaved changes · revision 2");

  preferences.fail({
    name: "models.watch",
    label: "model preferences",
    error: new Error("watch ended"),
  });
  const note = models().getByRole("note");
  const retry = models().getByRole("button", { name: "Retry", exact: true });
  await expect.element(note).toMatchTextContent("Model preferences stopped updating");
  await expect.element(unavailableStatus()).not.toBeInTheDocument();
  await expect.element(unsavedStatus()).toHaveTextContent("Unsaved changes · revision 2");

  retry.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(preferences.retries()).toBe(1);
  await expect.element(note).toMatchTextContent("Retrying model preferences");
  await expect.element(note).toHaveAttribute("aria-busy", "true");
  await expect.element(unsavedStatus()).toHaveTextContent("Unsaved changes · revision 2");
  preferences.set({
    loaded: true,
    items: [{ scope, revision: 3, policy: defaultModelPolicy() }],
  });
  await expect.element(note).not.toBeInTheDocument();
  const reason = models().getByRole("alert");
  await expect.element(reason).toMatchTextContent("Changed in another client");
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();
  await expect.element(unsavedStatus()).toHaveTextContent("Unsaved changes · revision 2");
  await expect.element(saveButton()).toBeDisabled();
});

test("long profile names stay inside Settings with an actual-overflow full-name title", async () => {
  const { client } = await openManager();
  const name = "W".repeat(80);
  await writeConfig(`[tasks]\nagent = "pi"\n[profiles.long]\nname = "${name}"\nagent = "pi"\n`);
  await vi.waitFor(() => expect(client.config.getSnapshot().profiles[0]?.name).toBe(name));
  await models().getByRole("combobox", { name: "Model tool/profile", exact: true }).click();
  await page.getByRole("option", { name: `pi · ${name}`, exact: true }).click();
  const field = models()
    .getByRole("combobox", { name: "Model tool/profile", exact: true })
    .element();
  await vi.waitFor(() => expect(field.querySelector("[title]")?.getAttribute("title")).toBe(name));
  expect(models().element().scrollWidth).toBeLessThanOrEqual(models().element().clientWidth);
  expect(field.getBoundingClientRect().width).toBeLessThanOrEqual(320);
});

test("another client's save makes a dirty draft stale: Save is disabled with its reason, Discard loads the latest and clears it", async () => {
  const { client } = await openManager();
  const peer = newClient();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(peer.connection.state.getSnapshot().status).toBe("connected"));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved()?.revision ?? 0;
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${baseRevision}`);

  const peerSaved = await peer.connection.api.models.save({
    scope,
    revision: baseRevision,
    policy: { ...defaultModelPolicy(), deny: [{ type: "provider", provider: "stub" }] },
  });
  const reason = models().getByRole("alert");
  await expect.element(reason).toMatchTextContent("Changed in another client");
  await expect.element(reason).toMatchTextContent("Your draft is kept");
  await expect
    .element(reason)
    .toMatchTextContent("Discard loads the latest version and drops the draft");
  await vi.waitFor(() => expect(saved()?.revision).toBe(peerSaved.revision));
  await expect.element(saveButton()).toBeDisabled();
  const describedBy = saveButton().element().getAttribute("aria-describedby");
  expect(describedBy).not.toBeNull();
  expect(document.getElementById(describedBy ?? "")).toBe(reason.element());
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${baseRevision}`);
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();

  await settings().getByRole("button", { name: "Close settings" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Discard unsaved model preferences?",
  });
  await expect.element(confirm).toBeVisible();
  await expect
    .element(confirm.getByRole("button", { name: "Keep editing", exact: true }))
    .toHaveFocus();
  await confirm.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect.element(confirm).not.toBeInTheDocument();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();

  await models().getByRole("button", { name: "Discard", exact: true }).click();
  await expect.element(reason).not.toBeInTheDocument();
  await expect.element(checkbox("Show Stub Two · stub")).not.toBeChecked();
  await expect.element(checkbox("Show Stub Two · stub")).toBeDisabled();
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${peerSaved.revision}`);
  await expect.element(saveButton()).toBeDisabled();
  await settings().getByRole("button", { name: "Close settings" }).click();
  await expect.element(settings()).not.toBeInTheDocument();
});

test("an idle editor takes another client's save and stays clean", async () => {
  const { client } = await openManager();
  const peer = newClient();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(peer.connection.state.getSnapshot().status).toBe("connected"));
  const saved = client.modelPreferences
    .getSnapshot()
    .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved?.revision ?? 0;
  const peerSaved = await peer.connection.api.models.save({
    scope,
    revision: baseRevision,
    policy: { ...defaultModelPolicy(), deny: [{ type: "provider", provider: "stub" }] },
  });
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${peerSaved.revision}`);
  await expect.element(checkbox("Show Stub One · stub")).not.toBeChecked();
  await expect.element(checkbox("Show Stub One · stub")).toBeDisabled();
  await expect.element(saveButton()).toBeDisabled();
});

test("a watch snapshot that predates the save acknowledgement cannot restore the saved policy", async () => {
  let stale: PreferencesSnapshot | undefined;
  let preferences: FakePreferences | undefined;
  await openManager({
    beforeManage: (each) => {
      stale = each.modelPreferences.getSnapshot();
      preferences = fakePreferences(stale);
      installPreferences(each, preferences);
    },
  });
  await expect.element(checkbox("Show Stub Two · stub")).toBeVisible();
  const baseRevision =
    stale?.items.find((item) => modelScopeKey(item.scope) === modelScopeKey(scope))?.revision ?? 0;
  await checkbox("Show Stub Two · stub").click();
  await saveButton().click();
  const savedRevision = await vi.waitFor(() => {
    const text = savedStatus().element().textContent ?? "";
    const revision = Number(/revision (\d+)/.exec(text)?.[1]);
    if (!Number.isFinite(revision) || revision === baseRevision)
      throw new Error("save has not landed");
    return revision;
  });

  // The acknowledgement landed (revision B); the watch is still showing revision A. Treating the
  // different number as newer would restore the policy the save just replaced.
  preferences!.set(stale!);
  await expect.element(checkbox("Show Stub Two · stub")).not.toBeChecked();
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${savedRevision}`);
  await expect.element(saveButton()).toBeDisabled();

  // An edit in that window is based on the acknowledged policy, so it is not a conflict and its
  // save sends the acknowledged revision.
  await checkbox("Show Stub One · stub").click();
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${savedRevision}`);
  await expect.element(models().getByRole("alert")).not.toBeInTheDocument();
  await saveButton().click();
  await expect.element(savedStatus()).toMatchTextContent("Saved · revision");
  await expect.element(models().getByRole("alert")).not.toBeInTheDocument();
});

test("a revision that changes while Save is in flight fails the save and keeps the draft", async () => {
  const { client } = await openManager();
  const peer = newClient();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(peer.connection.state.getSnapshot().status).toBe("connected"));
  const saved = client.modelPreferences
    .getSnapshot()
    .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved?.revision ?? 0;
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  const { release } = holdNextSave(client);
  await saveButton().click();
  await expect.element(saveButton()).toBeDisabled();
  await expect.element(savingStatus()).toHaveTextContent("Saving…");
  await expect.element(unsavedStatus()).not.toBeInTheDocument();

  await peer.connection.api.models.save({
    scope,
    revision: baseRevision,
    policy: { ...defaultModelPolicy(), deny: [{ type: "provider", provider: "stub" }] },
  });
  await expect.element(models().getByRole("alert")).toMatchTextContent("Changed in another client");
  await expect.element(savingStatus()).toHaveTextContent("Saving…");
  await expect.element(unsavedStatus()).not.toBeInTheDocument();
  release();

  await expect.element(models().getByText("Could not save.", { exact: false })).toBeVisible();
  await expect.element(models().getByText("Your draft is intact", { exact: false })).toBeVisible();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${baseRevision}`);
  await expect.element(savingStatus()).not.toBeInTheDocument();
  await expect.element(saveButton()).toBeDisabled();
});

test("the footer follows the save lifecycle: unsaved before the request, Saving… while it is held, Saved after the ack", async () => {
  const { client } = await openManager();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved()?.revision ?? 0;
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${baseRevision}`);

  const { release } = holdNextSave(client);
  await saveButton().click();
  await expect.element(saveButton()).toBeDisabled();
  await expect.element(savingStatus()).toHaveTextContent("Saving…");
  await expect.element(unsavedStatus()).not.toBeInTheDocument();

  release();
  const savedRevision = await vi.waitFor(() => {
    const current = saved()?.revision;
    if (current === undefined || current === baseRevision) throw new Error("save has not landed");
    return current;
  });
  await expect.element(savedStatus()).toHaveTextContent(`Saved · revision ${savedRevision}`);
  await expect.element(savingStatus()).not.toBeInTheDocument();
});

test("saving from the keyboard announces the footer status and returns focus there; a refused save keeps the draft and focus in the dialog", async () => {
  const { client } = await openManager();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved()?.revision ?? 0;
  await checkbox("Show Stub Two · stub").click();
  saveButton().element().focus();
  await userEvent.keyboard("{Enter}");
  const nextRevision = await vi.waitFor(() => {
    const current = saved()?.revision;
    if (current === undefined || current === baseRevision) throw new Error("save has not landed");
    return current;
  });
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${nextRevision}`);
  expect(savedStatus().element().getAttribute("role")).toBe("status");
  expect(savedStatus().element().tabIndex).toBe(-1);
  await expect.element(savedStatus()).toHaveFocus();
  expect(document.activeElement).not.toBe(document.body);
  expect(settings().element().contains(document.activeElement)).toBe(true);
  await expect.element(saveButton()).toBeDisabled();
  saveButton().element().focus();
  expect(document.activeElement).toBe(savedStatus().element());
  await userEvent.keyboard("{Tab}");
  await expect
    .element(models().getByRole("button", { name: "Hide all", exact: true }))
    .toHaveFocus();
  models().getByRole("button", { name: "Preview", exact: true }).element().focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).not.toBe(saveButton().element());
  await vi.waitFor(() => expect(saved()?.revision).toBe(nextRevision));
  const peer = newClient();
  await vi.waitFor(() => expect(peer.connection.state.getSnapshot().status).toBe("connected"));
  await checkbox("Show Stub Two · stub").click();
  const { release } = holdNextSave(client);
  saveButton().element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(saveButton()).toBeDisabled();
  await peer.connection.api.models.save({
    scope,
    revision: nextRevision,
    policy: { ...defaultModelPolicy(), mode: "allow" },
  });
  await expect.element(models().getByRole("alert")).toMatchTextContent("Changed in another client");
  release();
  await expect.element(models().getByText("Could not save.", { exact: false })).toBeVisible();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();
  await expect.element(unsavedStatus()).toHaveFocus();
  expect(settings().element().contains(document.activeElement)).toBe(true);
});

test("a pointer save also lands the keyboard on the footer status", async () => {
  const { client } = await openManager();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved()?.revision ?? 0;
  await checkbox("Show Stub Two · stub").click();
  await saveButton().click();
  const nextRevision = await vi.waitFor(() => {
    const current = saved()?.revision;
    if (current === undefined || current === baseRevision) throw new Error("save has not landed");
    return current;
  });
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${nextRevision}`);
  await expect.element(savedStatus()).toHaveFocus();
  expect(settings().element().contains(document.activeElement)).toBe(true);
});

test("a move made during an in-flight save is not pulled back by the ack", async () => {
  const { client } = await openManager();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved()?.revision ?? 0;
  await checkbox("Show Stub Two · stub").click();
  const { release } = holdNextSave(client);
  saveButton().element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(saveButton()).toBeDisabled();
  findModels().element().focus();
  await expect.element(findModels()).toHaveFocus();
  release();
  const nextRevision = await vi.waitFor(() => {
    const current = saved()?.revision;
    if (current === undefined || current === baseRevision) throw new Error("save has not landed");
    return current;
  });
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${nextRevision}`);
  await expect.element(findModels()).toHaveFocus();
  await expect.element(savedStatus()).not.toHaveFocus();
});

const previewDialog = () =>
  page.getByRole("dialog", { name: "Model visibility preview", exact: true });

/** Opens routed Settings at one viewport, closes Preview twice and Settings once with Escape. */
async function assertPreviewReturnsFocus(width: number, height: number) {
  await page.viewport(width, height);
  await settingsEntry().click();
  await expect.element(settings()).toBeVisible();
  await settingsCategories().getByRole("button", { name: "Models", exact: true }).click();
  const previewButton = models().getByRole("button", { name: "Preview", exact: true });
  await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  await previewButton.click();
  await expect.element(previewDialog()).toBeVisible();
  await expect.element(previewDialog().getByRole("option", { name: /Stub One/ })).toBeDisabled();
  await expect.element(previewDialog().getByRole("option", { name: /Stub Two/ })).toBeDisabled();
  // The preview is a picker view with no footer copy and no explanatory sentence.
  expect(previewDialog().element().querySelectorAll("p")).toHaveLength(0);

  // The nested dialog closes alone and returns its own opener, never the body.
  const closePreview = async () => {
    await userEvent.keyboard("{Escape}");
    await expect.element(previewDialog()).not.toBeInTheDocument();
    await expect.element(settings()).toBeVisible();
    expect(document.activeElement).not.toBe(document.body);
    expect(settings().element().contains(document.activeElement)).toBe(true);
    await expect.element(previewButton).toHaveFocus();
  };
  await closePreview();

  // A second open and close in the same Settings session keeps the same return target.
  await previewButton.click();
  await expect.element(previewDialog()).toBeVisible();
  await closePreview();

  // Settings still owns its opener: the next Escape leaves it and returns to that button.
  await userEvent.keyboard("{Escape}");
  await expect.element(settings()).not.toBeInTheDocument();
  await expect.element(settingsEntry()).toHaveFocus();
}

test("closing the Models Preview returns the keyboard to its button while Settings keeps its own opener", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  await appWithProject(client);
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  try {
    await assertPreviewReturnsFocus(1024, 640);
    await assertPreviewReturnsFocus(1920, 1080);
    expect(document.activeElement).toBe(settingsEntry().element());
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});
