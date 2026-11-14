import { defaultClientConfig, type LaunchProfile } from "@corral/protocol/config";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render as renderComponent } from "vitest-browser-react";
import type { ReactElement } from "react";
import { CorralClientProvider } from "../connection/index.ts";
import { realServerClients } from "../../../test/real-client.ts";
import { AgentPicker } from "./agent-picker.tsx";
import type { AgentLaunchChoice } from "./launch-choice.ts";

const { newClient } = realServerClients();
function render(ui: ReactElement) {
  const client = newClient();
  return renderComponent(ui, {
    wrapper: ({ children }) => (
      <CorralClientProvider client={client}>{children}</CorralClientProvider>
    ),
  });
}

const dialog = () => page.getByRole("dialog", { name: "New agent session" });
const radios = () => dialog().getByRole("radio");
const option = (name: string | RegExp) => dialog().getByRole("option", { name });

function profile(overrides: Partial<LaunchProfile>): LaunchProfile {
  return {
    id: "claude-gateway",
    name: "Claude gateway",
    agent: "claude",
    model: "claude-sonnet-4-5",
    provider: null,
    env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "CLAUDE_TOKEN" }],
    revision: "0123456789ab",
    ...overrides,
  };
}

const claude = profile({});
const codex = profile({
  id: "codex-work",
  name: "Codex work",
  agent: "codex",
  model: "gpt-5-codex",
  provider: "openai",
  env: [],
  revision: "111111111111",
});
const opencode = profile({
  id: "opencode-team",
  name: "OpenCode team",
  agent: "opencode",
  model: null,
  env: [{ targetName: "OPENAI_API_KEY", fromEnv: "TEAM_KEY" }],
  revision: "222222222222",
});
const profiles: LaunchProfile[] = [claude, codex, opencode];

async function opened(list: LaunchProfile[] = []) {
  const onStart = vi.fn<(choice: AgentLaunchChoice) => Promise<void>>(async () => undefined);
  const onClose = vi.fn<() => void>();
  const screen = await render(
    <AgentPicker
      profiles={list}
      agents={defaultClientConfig("").agents}
      settings={defaultClientConfig("").tasks}
      chatDrivers={["claude", "codex", "pi", "opencode"]}
      capabilitiesReady
      onStart={onStart}
      onClose={onClose}
    />,
  );
  // The routed picker opens with its search field focused; keyboard instance shortcuts are a rail
  // affordance, so the tests move focus there explicitly.
  await expect.element(dialog()).toBeVisible();
  await dialog().getByRole("radio", { name: "claude" }).click();
  return { screen, onStart, onClose };
}

test("it lists the four native defaults and then each configured profile", async () => {
  await opened(profiles);

  await expect.element(radios()).toHaveLength(7);
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toBeChecked();
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeVisible();
  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(option("claude-sonnet-4-5 · Configured default")).toBeVisible();
  await dialog().getByRole("radio", { name: "Codex work" }).click();
  await expect.element(option("gpt-5-codex · Configured default")).toBeVisible();
  await dialog().getByRole("radio", { name: "OpenCode team" }).click();
  expect(dialog().getByText("Configured default").elements()).toHaveLength(0);
});

test("a fresh digit picks that native agent straight away, without a profile or model", async () => {
  const { onStart } = await opened(profiles);

  await userEvent.keyboard("3");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "pi", view: "chat" });
});

test("arrows move onto profiles; Enter starts the highlighted profile", async () => {
  const { onStart } = await opened(profiles);

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();
  await userEvent.keyboard("{Enter}");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({
    kind: "claude",
    view: "chat",
    profileId: "claude-gateway",
    expectedProfileRevision: "0123456789ab",
  });
});

test("choosing a catalog model for a native choice sends it", async () => {
  const { onStart } = await opened(profiles);

  await dialog().getByRole("radio", { name: "pi", exact: true }).click();
  await expect.element(option(/Stub Two/)).toBeVisible();
  await option(/Stub Two/).click();

  expect(onStart).toHaveBeenCalledExactlyOnceWith({
    kind: "pi",
    view: "chat",
    model: "stub/stub-2",
  });
});

test("OpenCode offers no model rows, for a native choice or its profile", async () => {
  await opened(profiles);

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect.element(dialog().getByRole("radio", { name: "opencode" })).toBeChecked();
  expect(dialog().getByText("Configured default").elements()).toHaveLength(0);
  expect(dialog().getByRole("textbox", { name: "Model override" }).elements()).toHaveLength(0);

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect.element(dialog().getByRole("radio", { name: "OpenCode team" })).toBeChecked();
  expect(dialog().getByText("Configured default").elements()).toHaveLength(0);
  expect(dialog().getByRole("textbox", { name: "Model override" }).elements()).toHaveLength(0);
});

test("a refused launch keeps the picker open with the draft and the typed reason", async () => {
  const onStart = vi.fn<(choice: AgentLaunchChoice) => Promise<void>>(async () => {
    throw {
      code: "LAUNCH_ENV_MISSING",
      defined: true,
      data: { profileId: "claude-gateway", name: "CLAUDE_TOKEN" },
    };
  });
  const onClose = vi.fn<() => void>();
  await render(
    <AgentPicker
      profiles={profiles}
      agents={defaultClientConfig("").agents}
      settings={defaultClientConfig("").tasks}
      chatDrivers={["claude", "codex", "pi", "opencode"]}
      capabilitiesReady
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await expect.element(dialog()).toBeVisible();
  await dialog().getByRole("radio", { name: "claude" }).click();

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  await userEvent.keyboard("{Enter}");

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("no environment variable CLAUDE_TOKEN");
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();
  expect(onClose).not.toHaveBeenCalled();
});

test("a retained agent disabled in live config names the refusal and cannot start", async () => {
  const { screen, onStart } = await opened(profiles);
  const config = defaultClientConfig("");
  config.agents.claude.enabled = { value: false, source: "global" };
  await screen.rerender(
    <AgentPicker
      profiles={profiles}
      agents={config.agents}
      settings={config.tasks}
      chatDrivers={["claude", "codex", "pi", "opencode"]}
      capabilitiesReady
      onStart={onStart}
      onClose={() => undefined}
    />,
  );
  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("The claude agent is disabled in the config file. Choose another agent.");
  await userEvent.keyboard("{Enter}");
  expect(onStart).not.toHaveBeenCalled();
});

test("a profile dropped from the live config disables Start and never starts native", async () => {
  const { screen, onStart } = await opened(profiles);
  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();

  await screen.rerender(
    <AgentPicker
      profiles={[codex]}
      agents={defaultClientConfig("").agents}
      settings={defaultClientConfig("").tasks}
      chatDrivers={["claude", "codex", "pi", "opencode"]}
      capabilitiesReady
      onStart={onStart}
      onClose={() => undefined}
    />,
  );

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent(
      'The profile "Claude gateway" is no longer in the config file. Choose an agent or another profile.',
    );

  // Enter from the stale selection must not submit the first choice (native claude).
  dialog().getByRole("radio", { name: "claude" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onStart).not.toHaveBeenCalled();

  // Recovery is an explicit choice; Enter on the chosen instance starts it.
  await dialog().getByRole("radio", { name: "pi" }).click();
  await userEvent.keyboard("{Enter}");
  expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "pi", view: "chat" });
});

test("a profile whose revision changed needs an explicit reselect before it can start", async () => {
  const { screen, onStart } = await opened(profiles);
  await dialog().getByRole("radio", { name: "Claude gateway" }).click();

  const changed = profile({ revision: "ffffffffffff", model: "claude-opus-4-1" });
  await screen.rerender(
    <AgentPicker
      profiles={[changed, codex, opencode]}
      agents={defaultClientConfig("").agents}
      settings={defaultClientConfig("").tasks}
      chatDrivers={["claude", "codex", "pi", "opencode"]}
      capabilitiesReady
      onStart={onStart}
      onClose={() => undefined}
    />,
  );

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent(
      'The profile "Claude gateway" changed on the server. Review it and choose it again.',
    );
  dialog().getByRole("radio", { name: "claude" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onStart).not.toHaveBeenCalled();

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(option("claude-opus-4-1 · Configured default")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(onStart).toHaveBeenCalledExactlyOnceWith({
    kind: "claude",
    view: "chat",
    profileId: "claude-gateway",
    expectedProfileRevision: "ffffffffffff",
  });
});

test("a server-side revision conflict keeps the draft and needs an explicit reselect", async () => {
  let calls = 0;
  const onStart = vi.fn<(choice: AgentLaunchChoice) => Promise<void>>(async () => {
    calls += 1;
    if (calls === 1) {
      throw {
        code: "LAUNCH_PROFILE_CHANGED",
        defined: true,
        data: { id: "claude-gateway" },
      };
    }
  });
  const onClose = vi.fn<() => void>();
  const screen = await render(
    <AgentPicker
      profiles={profiles}
      agents={defaultClientConfig("").agents}
      settings={defaultClientConfig("").tasks}
      chatDrivers={["claude", "codex", "pi", "opencode"]}
      capabilitiesReady
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await expect.element(dialog()).toBeVisible();
  await dialog().getByRole("radio", { name: "claude" }).click();

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await userEvent.keyboard("{Enter}");

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent(
      'The profile "Claude gateway" changed on the server. Review it and choose it again.',
    );
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onStart).toHaveBeenNthCalledWith(1, {
    kind: "claude",
    view: "chat",
    profileId: "claude-gateway",
    expectedProfileRevision: "0123456789ab",
  });

  // Retrying the same pinned revision is blocked; nothing is auto-refreshed or sent native.
  await userEvent.keyboard("{Enter}");
  expect(onStart).toHaveBeenCalledTimes(1);

  const changed = profile({ revision: "ffffffffffff", model: "claude-haiku-4" });
  await screen.rerender(
    <AgentPicker
      profiles={[changed, codex, opencode]}
      agents={defaultClientConfig("").agents}
      settings={defaultClientConfig("").tasks}
      chatDrivers={["claude", "codex", "pi", "opencode"]}
      capabilitiesReady
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent(
      'The profile "Claude gateway" changed on the server. Review it and choose it again.',
    );

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(dialog().getByRole("alert")).not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");

  expect(onStart).toHaveBeenCalledTimes(2);
  // Reselecting the revised profile starts from that profile; the old typed override was
  // discarded with the revision it belonged to rather than carried into the new launch.
  expect(onStart).toHaveBeenLastCalledWith({
    kind: "claude",
    view: "chat",
    profileId: "claude-gateway",
    expectedProfileRevision: "ffffffffffff",
  });
});

test("a digit never discards a selected profile", async () => {
  const { onStart } = await opened(profiles);

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();
  await userEvent.keyboard("2");
  await userEvent.keyboard("4");
  expect(onStart).not.toHaveBeenCalled();
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();
});

test("modified or composing digits make no launch and leave the draft alone", async () => {
  const { onStart } = await opened(profiles);
  const radio = dialog().getByRole("radio", { name: "claude" }).element();
  radio.focus();

  for (const modifier of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
  ]) {
    radio.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "3",
        code: "Digit3",
        bubbles: true,
        cancelable: true,
        ...modifier,
      }),
    );
  }
  radio.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "3",
      code: "Digit3",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    }),
  );
  expect(onStart).not.toHaveBeenCalled();

  // A plain digit still works from the list.
  radio.focus();
  await userEvent.keyboard("3");
  expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "pi", view: "chat" });
});

test("Close and Escape dismiss it without starting anything", async () => {
  const { onStart, onClose } = await opened(profiles);

  // The picker has no close button; Escape is its dismissal.
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onStart).not.toHaveBeenCalled();
});

test("a digit beyond the native list does nothing and Enter still starts claude", async () => {
  const { onStart } = await opened(profiles);

  await userEvent.keyboard("5");
  await userEvent.keyboard("0");
  expect(onStart).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "claude", view: "chat" });
});
