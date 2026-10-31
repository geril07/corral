import type { CorralClient } from "@corral/client/corral-client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import { appWithProject, createTask, taskButton } from "../../../test/task-flows.tsx";

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

const settingsHeading = () => page.getByRole("heading", { name: "Settings", level: 1 });
const section = (name: string) => page.getByRole("region", { name });
const settingsButton = () => page.getByRole("button", { name: "Settings" });

async function renderSettings(client: CorralClient) {
  await render(<App client={client} initialEntries={["/settings"]} />);
  await expect.element(settingsHeading()).toBeVisible();
}

test("the settings surface shows effective keys, profiles with reference names, and the file's problems", async () => {
  const client = newClient();
  await writeConfig(CONFIG);
  await renderSettings(client);
  await vi.waitFor(() => expect(client.config.getSnapshot().profiles).toHaveLength(3));

  await expect.element(page.getByText("read-only")).toBeVisible();

  const keys = section("Effective keys");
  await expect.element(keys).toMatchTextContent(/New agent session\s*unbound/);
  await expect.element(keys).toMatchTextContent(/Settings\s*alt\+a o/);
  await expect.element(keys).toMatchTextContent("Prefix");

  const profiles = section("Agent profiles");
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

  const config = section("Config file");
  await expect.element(config).toMatchTextContent(client.config.getSnapshot().path);
  await expect.element(config).toMatchTextContent("never writes it");
  await expect.element(config).toMatchTextContent("Problems (1)");
  await expect.element(config).toMatchTextContent("profiles.broken");
  await expect.element(config.getByRole("button", { name: "Copy config path" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: /save/i })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /create/i })).not.toBeInTheDocument();
});

test("a problem at the profiles table itself is shown, not only per-profile paths", async () => {
  const client = newClient();
  await writeConfig('[profiles."bad id"]\nname = "P"\nagent = "claude"\n');
  await renderSettings(client);
  await vi.waitFor(() => expect(client.config.getSnapshot().problems).toHaveLength(1));

  const config = section("Config file");
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

  const profiles = section("Agent profiles");
  await expect.element(profiles).toMatchTextContent("Live profile");
  await expect.element(profiles).toMatchTextContent("model and provider (model required)");
  await expect.element(profiles).not.toMatchTextContent("Claude gateway");
  await expect.element(section("Config file")).toMatchTextContent("No problems");
});

test("the sidebar entry opens settings; Escape and Back return to the same task with focus on the entry", async () => {
  const client = newClient();
  await appWithProject(client);
  await createTask("Settings trip");

  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect.element(taskButton("Settings trip")).toHaveAttribute("aria-current", "true");
  await expect.element(settingsButton()).toHaveFocus();

  await settingsButton().click();
  await expect.element(settingsHeading()).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(settingsHeading()).not.toBeInTheDocument();
  await expect.element(taskButton("Settings trip")).toHaveAttribute("aria-current", "true");
  await expect.element(settingsButton()).toHaveFocus();
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
  await expect.element(section("Effective keys")).toMatchTextContent(/Settings\s*alt\+a q/);

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
});
