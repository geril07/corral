import type { LaunchProfile } from "@corral/protocol/config";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { AgentPicker } from "./agent-picker.tsx";
import type { AgentLaunchChoice } from "./launch-choice.ts";

const dialog = () => page.getByRole("dialog", { name: "New agent session" });
const radios = () => dialog().getByRole("radio");
const modelInput = () => dialog().getByRole("textbox", { name: "Model override" });

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

const profiles: LaunchProfile[] = [
  profile({}),
  profile({
    id: "codex-work",
    name: "Codex work",
    agent: "codex",
    model: "gpt-5-codex",
    provider: "openai",
    env: [],
    revision: "111111111111",
  }),
  profile({
    id: "opencode-team",
    name: "OpenCode team",
    agent: "opencode",
    model: null,
    env: [{ targetName: "OPENAI_API_KEY", fromEnv: "TEAM_KEY" }],
    revision: "222222222222",
  }),
];

async function opened(list: LaunchProfile[] = []) {
  const onStart = vi.fn<(choice: AgentLaunchChoice) => Promise<void>>(async () => undefined);
  const onClose = vi.fn<() => void>();
  await render(<AgentPicker profiles={list} onStart={onStart} onClose={onClose} />);
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toHaveFocus();
  return { onStart, onClose };
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

test("a digit picks that native agent straight away, without a profile or typed model", async () => {
  const { onStart } = await opened(profiles);

  await modelInput().fill("claude-opus-4-1");
  await dialog().getByRole("radio", { name: "codex" }).click();
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
  });
});

test("a typed model overrides the profile's model and reaches the launch", async () => {
  const { onStart } = await opened(profiles);

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  await modelInput().fill("claude-opus-4-1");
  await userEvent.keyboard("{Enter}");

  expect(onStart).toHaveBeenCalledExactlyOnceWith({
    kind: "claude",
    profileId: "claude-gateway",
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
  await render(<AgentPicker profiles={profiles} onStart={onStart} onClose={onClose} />);
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
