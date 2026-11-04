import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  openAgentSessionPicker,
  addProject,
  createRepo,
  createTask,
  openedWindow,
  sessionTabs,
  workspace,
} from "./app-helpers.ts";
import { readLaunches, test } from "./fixtures.ts";

function writeConfig(stateDir: string, text: string) {
  const directory = path.join(stateDir, "config");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "config.toml"), text);
}

// A safe placeholder, not a credential: the profile only needs the server to have the name.
const ENV_SENTINEL = "e2e-profile-sentinel";

test("a profile and typed model start in Electron, and settings shows the profile read-only", async ({
  launchApp,
  stateDir,
}) => {
  process.env["E2E_PROFILE_TOKEN"] = ENV_SENTINEL;
  writeConfig(
    stateDir,
    `[profiles.claude-sonnet]
name = "Claude sonnet"
agent = "claude"
model = "claude-sonnet-4-5"
env = [{ targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "E2E_PROFILE_TOKEN" }]
`,
  );

  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Profiles");

  await openAgentSessionPicker(window, "terminal");
  const picker = window.getByRole("dialog", { name: "New agent session" });
  const profile = picker.getByRole("radio", { name: "Claude sonnet" });
  await expect(profile).toBeVisible();
  await profile.click();
  await picker.getByRole("textbox", { name: "Model override" }).fill("claude-opus-4-1");
  await picker.getByRole("option").last().click();
  await expect(picker).toBeHidden();

  const tab = sessionTabs(window).getByRole("tab", { name: /^claude Claude sonnet/ });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      readLaunches(stateDir)
        .find((launch) => launch.agent === "claude")
        ?.argv.slice(0, 2),
    )
    .toEqual(["--model", "claude-opus-4-1"]);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyO");
  const settings = window.getByRole("heading", { name: "Settings", level: 1 });
  await expect(settings).toBeVisible();
  await window
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Agent profiles", exact: true })
    .click();
  const profiles = window.getByRole("region", { name: "Agent profiles" });
  await expect(window.getByText("read-only", { exact: true })).toBeVisible();
  await expect(profiles).toContainText("Claude sonnet");
  await expect(profiles).toContainText("claude-sonnet-4-5");
  await profiles.getByRole("button", { name: "environment references for Claude sonnet" }).click();
  await expect(profiles).toContainText("ANTHROPIC_AUTH_TOKEN");
  await expect(profiles).toContainText("E2E_PROFILE_TOKEN");
  await expect(profiles.getByRole("button", { name: /save|create/i })).toHaveCount(0);

  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(workspace(window).getByRole("button", { name: /^Profiles/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  // Keyboard-opened settings return to the terminal, not a route's sidebar fallback.
  await expect(window.locator(".terminal-host .xterm-helper-textarea")).toBeFocused();
});
