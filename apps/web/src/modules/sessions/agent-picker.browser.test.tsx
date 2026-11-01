import { defaultClientConfig, type LaunchProfile } from "@corral/protocol/config";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { AgentPicker } from "./agent-picker.tsx";
import type { AgentLaunchChoice } from "./launch-choice.ts";

const dialog = () => page.getByRole("dialog", { name: "New agent session" });
const radios = () => dialog().getByRole("radio");
const modelInput = () => dialog().getByRole("textbox", { name: "Model override" });
const startButton = () => dialog().getByRole("button", { name: "Start session" });
const summary = () => dialog().getByLabelText("launch choice");

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
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toHaveFocus();
  return { screen, onStart, onClose };
}

test("it lists the four native defaults and then each configured profile", async () => {
  await opened(profiles);

  await expect.element(radios()).toHaveLength(7);
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toBeChecked();
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeVisible();
  await expect.element(dialog()).toMatchTextContent("claude-sonnet-4-5");
  await expect.element(dialog()).toMatchTextContent("provider openai");
  await expect.element(dialog()).toMatchTextContent("env only");
});

test("a fresh digit picks that native agent straight away, without a profile or model", async () => {
  const { onStart } = await opened(profiles);

  await userEvent.keyboard("3");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "pi" });
});

test("arrows move onto profiles; Enter starts the highlighted profile", async () => {
  const { onStart } = await opened(profiles);

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();
  await userEvent.keyboard("{Enter}");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({
    kind: "claude",
    profileId: "claude-gateway",
    expectedProfileRevision: "0123456789ab",
  });
});

test("a typed model overrides the profile's model in the summary and in the payload", async () => {
  const { onStart } = await opened(profiles);

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await modelInput().fill("claude-opus-4-1");
  await expect.element(summary()).toMatchTextContent("claude-opus-4-1");
  await expect.element(summary()).not.toMatchTextContent("claude-sonnet-4-5");
  await userEvent.keyboard("{Enter}");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({
    kind: "claude",
    profileId: "claude-gateway",
    expectedProfileRevision: "0123456789ab",
    model: "claude-opus-4-1",
  });
});

test("a typed override on a native choice replaces 'native defaults' in the summary", async () => {
  const { onStart } = await opened(profiles);

  await modelInput().fill("claude-opus-4-1");
  await expect.element(summary()).toMatchTextContent("claude with model claude-opus-4-1");
  await expect.element(summary()).not.toMatchTextContent("native defaults");
  await userEvent.keyboard("{Enter}");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({
    kind: "claude",
    model: "claude-opus-4-1",
  });
});

test("an invalid native model id keeps the draft and says why", async () => {
  const { onStart } = await opened(profiles);

  await modelInput().fill("bad model");
  await userEvent.keyboard("{Enter}");

  expect(onStart).not.toHaveBeenCalled();
  await expect.element(dialog().getByRole("alert")).toMatchTextContent("native model id");
  await expect.element(modelInput()).toHaveValue("bad model");
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toBeChecked();
});

test("OpenCode offers no model or provider field, for a native choice or its profile", async () => {
  await opened(profiles);

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect.element(dialog().getByRole("radio", { name: "opencode" })).toBeChecked();
  await expect.element(modelInput()).not.toBeInTheDocument();

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect.element(dialog().getByRole("radio", { name: "OpenCode team" })).toBeChecked();
  await expect.element(modelInput()).not.toBeInTheDocument();
  await expect.element(dialog()).toMatchTextContent("env only");
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
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  await modelInput().fill("claude-opus-4-1");
  await userEvent.keyboard("{Enter}");

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("no environment variable CLAUDE_TOKEN");
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();
  await expect.element(modelInput()).toHaveValue("claude-opus-4-1");
  expect(onClose).not.toHaveBeenCalled();
});

test("a profile dropped from the live config disables Start and never starts native", async () => {
  const { screen, onStart } = await opened(profiles);
  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();

  await screen.rerender(
    <AgentPicker
      profiles={[codex]}
      agents={defaultClientConfig("").agents}
      onStart={onStart}
      onClose={() => undefined}
    />,
  );

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("no longer in the config file");
  await expect.element(startButton()).toBeDisabled();
  await expect.element(summary()).toMatchTextContent("Claude gateway");

  // Enter from the stale selection must not submit the first choice (native claude).
  dialog().getByRole("radio", { name: "claude" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onStart).not.toHaveBeenCalled();

  // Recovery is an explicit choice.
  await dialog().getByRole("radio", { name: "pi" }).click();
  await expect.element(startButton()).toBeEnabled();
  await startButton().click();
  expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "pi" });
});

test("a profile whose revision changed needs an explicit reselect before it can start", async () => {
  const { screen, onStart } = await opened(profiles);
  await dialog().getByRole("radio", { name: "Claude gateway" }).click();

  const changed = profile({ revision: "ffffffffffff", model: "claude-opus-4-1" });
  await screen.rerender(
    <AgentPicker
      profiles={[changed, codex, opencode]}
      agents={defaultClientConfig("").agents}
      onStart={onStart}
      onClose={() => undefined}
    />,
  );

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("changed in the config file");
  await expect.element(startButton()).toBeDisabled();
  dialog().getByRole("radio", { name: "claude" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onStart).not.toHaveBeenCalled();

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(startButton()).toBeEnabled();
  await expect.element(summary()).toMatchTextContent("claude-opus-4-1");
  await startButton().click();
  expect(onStart).toHaveBeenCalledExactlyOnceWith({
    kind: "claude",
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
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toHaveFocus();

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await modelInput().fill("claude-opus-4-1");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("changed on the server");
  await expect.element(startButton()).toBeDisabled();
  await expect.element(modelInput()).toHaveValue("claude-opus-4-1");
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onStart).toHaveBeenNthCalledWith(1, {
    kind: "claude",
    profileId: "claude-gateway",
    expectedProfileRevision: "0123456789ab",
    model: "claude-opus-4-1",
  });

  // Retrying the same pinned revision is blocked; nothing is auto-refreshed or sent native.
  await userEvent.keyboard("{Enter}");
  expect(onStart).toHaveBeenCalledTimes(1);

  const changed = profile({ revision: "ffffffffffff", model: "claude-haiku-4" });
  await screen.rerender(
    <AgentPicker
      profiles={[changed, codex, opencode]}
      agents={defaultClientConfig("").agents}
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("changed in the config file");
  await expect.element(startButton()).toBeDisabled();

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(dialog().getByRole("alert")).not.toBeInTheDocument();
  await expect.element(startButton()).toBeEnabled();
  await startButton().click();

  expect(onStart).toHaveBeenCalledTimes(2);
  expect(onStart).toHaveBeenLastCalledWith({
    kind: "claude",
    profileId: "claude-gateway",
    expectedProfileRevision: "ffffffffffff",
    model: "claude-opus-4-1",
  });
});

test("a digit never discards a selected profile or a typed model", async () => {
  const { onStart } = await opened(profiles);

  await dialog().getByRole("radio", { name: "Claude gateway" }).click();
  await userEvent.keyboard("2");
  await userEvent.keyboard("4");
  expect(onStart).not.toHaveBeenCalled();
  await expect.element(dialog().getByRole("radio", { name: "Claude gateway" })).toBeChecked();

  await dialog().getByRole("radio", { name: "claude" }).click();
  await modelInput().fill("claude-opus-4-1");
  await dialog().getByRole("radio", { name: "codex" }).click();
  await userEvent.keyboard("3");
  expect(onStart).not.toHaveBeenCalled();
  await expect.element(modelInput()).toHaveValue("claude-opus-4-1");
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

  // Digits typed in the model field stay text, and a plain digit still works from the list.
  await modelInput().fill("2");
  await expect.element(modelInput()).toHaveValue("2");
  await modelInput().fill("");
  radio.focus();
  await userEvent.keyboard("3");
  expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "pi" });
});

test("Cancel and Escape close it without starting anything", async () => {
  const { onStart, onClose } = await opened(profiles);

  await dialog().getByRole("button", { name: "Cancel" }).click();
  expect(onClose).toHaveBeenCalledTimes(1);

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  expect(onStart).not.toHaveBeenCalled();
});

test("a digit beyond the native list does nothing and Enter still starts claude", async () => {
  const { onStart } = await opened(profiles);

  await userEvent.keyboard("5");
  await userEvent.keyboard("0");
  expect(onStart).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({ kind: "claude" });
});
