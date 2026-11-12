import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { writeConfig } from "../../../test/config-command.ts";
import { agentLaunches } from "../../../test/fake-agents.ts";
import { prefixThen, realServerClients, screenText } from "../../../test/real-client.ts";
import {
  appWithProject,
  focusedIsTerminal,
  promptField,
  sessionTab,
  shellTabs,
  taskWithShell,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

const composer = () => page.getByRole("form", { name: "New task" });
const card = (title: string) => page.getByRole("button", { name: new RegExp(title) });
const picker = (name: RegExp) => composer().getByRole("button", { name });

/** `prefix t` opens the draft directly for one project, else the project picker first. */
async function openDraft(projectName: string) {
  await prefixThen("t");
  const choice = page.getByRole("dialog", { name: "New task" });
  if (choice.elements().length > 0) {
    await choice.getByRole("option", { name: new RegExp(projectName) }).click();
  }
  await expect.element(promptField()).toHaveFocus();
}

async function pickAgent(name: string) {
  await picker(/^Agent /).click();
  await page
    .getByRole("dialog", { name: "Agent and model" })
    .getByRole("radio", { name, exact: true })
    .click();
  await userEvent.keyboard("{Escape}");
}

/** A fake agent's launch with the prompt as the agent would read it on its own command line. */
async function launchWithPrompt(prompt: string) {
  return (await agentLaunches()).find((launch) =>
    launch.argv.some((argument) => argument.trim() === prompt),
  );
}

test("a prompt typed into the composer creates the task and its agent works on it", async () => {
  const { client, project } = await appWithProject(newClient());
  await openDraft(project.name);

  await pickAgent("pi");
  await promptField().click();
  // The prompt, then Enter. Shift+Enter would have added a newline instead.
  await userEvent.keyboard("Explain the build{Enter}");

  // The task is there at once under the server's seed title, its primary agent already working.
  await expect.element(card("Explain the build")).toHaveAttribute("aria-current", "true");
  await expect.element(sessionTab("pi")).toHaveAttribute("aria-selected", "true");
  // No shell starts on its own.
  await expect.element(shellTabs()).toHaveLength(0);
  const task = client.tasks.getSnapshot().tasks[0]!;
  expect(task).toMatchObject({ prompt: "Explain the build", titleSource: "seed" });
  expect(task.primarySessionId).not.toBeNull();
  const session = client.sessions
    .getSnapshot()
    .sessions.find((candidate) => candidate.id === task.primarySessionId);
  expect(session).toMatchObject({ kind: "pi", view: "chat", terminalId: null });
  await expect
    .element(page.getByRole("log", { name: "Chat transcript" }))
    .toMatchTextContent("Explain the build");
});

test("each project's own defaults prefill the composer and name the agent the task starts", async () => {
  const { client, repo, project } = await appWithProject(newClient());

  // A global default and an override for this project: the composer renders what A0 resolved.
  await writeConfig(
    `[tasks]\nview = "terminal"\nagent = "codex"\nworkspace = "new-worktree"\n\n[projects."${repo}"]\nagent = "pi"\n`,
  );
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[repo]?.agent.value).toBe("pi"),
  );

  await openDraft(project.name);
  await userEvent.keyboard("Prefilled work");
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent pi");
  // The draft pins its launch when it opens, so a project switch would not re-resolve the agent.
  await expect.element(promptField()).toHaveValue("Prefilled work");
  await userEvent.click(promptField());
  await userEvent.keyboard("{Enter}");

  await expect.element(card("Prefilled work")).toHaveAttribute("aria-current", "true");
  const task = client.tasks.getSnapshot().tasks.find((each) => each.projectId === project.id)!;
  expect(task.ownsWorktree).toBe(true);
  expect(task.prompt).toBe("Prefilled work");
  await vi.waitFor(async () =>
    expect((await launchWithPrompt("Prefilled work"))?.agent).toBe("pi"),
  );
  await expect.element(shellTabs()).toHaveLength(0);

  // The config file is the server's for the whole suite: leave the other files their defaults.
  await writeConfig(null);
  await vi.waitFor(() => expect(client.config.getSnapshot().config.tasks.agent.value).toBeNull());
});

test("a project's chat view default opens the new task as chat", async () => {
  const { client, repo, project } = await appWithProject(newClient());
  const before = (await agentLaunches()).length;
  await writeConfig(`[projects."${repo}"]\nview = "chat"\n`);
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[repo]?.view.value).toBe("chat"),
  );

  await openDraft(project.name);
  await pickAgent("codex");
  await pickAgent("pi");

  await userEvent.click(promptField());
  await userEvent.keyboard("Chat from the composer{Enter}");

  // The primary session opens as chat: pi's tab, the chat lane, and no terminal for it.
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await vi.waitFor(async () => {
    const fresh = (await agentLaunches()).slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.agent).toBe("pi");
    expect(fresh[0]?.argv).toContain("rpc");
  });

  // The config file is the server's for the whole suite: leave the other files their defaults.
  await writeConfig(null);
  await vi.waitFor(() => expect(client.config.getSnapshot().config.projects[repo]).toBeUndefined());
});

test("a disabled agent disappears from the pickers and the task starts one still enabled", async () => {
  const { client, project } = await appWithProject(newClient());
  const before = (await agentLaunches()).length;
  await writeConfig("[agents.claude]\nenabled = false\n");
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.agents.claude.enabled.value).toBe(false),
  );

  await openDraft(project.name);
  // The default falls to the first agent still offered; claude is not in the list at all.
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex");
  await userEvent.click(picker(/^Agent /));
  await expect.element(page.getByRole("radio", { name: /^claude/ })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(promptField());
  await userEvent.keyboard("Enabled agent only{Enter}");
  await expect.element(card("Enabled agent only")).toHaveAttribute("aria-current", "true");

  await vi.waitFor(async () => {
    const fresh = (await agentLaunches()).slice(before);
    expect(fresh.map((launch) => launch.agent)).toEqual(["codex"]);
  });

  await writeConfig(null);
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.agents.claude.enabled.value).toBe(true),
  );
});

test("Escape leaves the composer and returns the keyboard to the task that was selected", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Back here");

  await openDraft(project.name);
  await userEvent.keyboard("Not this one{Escape}");

  await expect.element(composer()).not.toBeInTheDocument();
  await expect.element(card("Back here")).toHaveAttribute("aria-current", "true");
  await userEvent.click(page.getByRole("region", { name: "active terminal" }));
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo back-$((2+2)){Enter}");
  await expect.poll(screenText).toContain("back-4");
});

test("prefix t focuses the prompt of a composer that is open over a task", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Focus me");

  await openDraft(project.name);
  // The keyboard is somewhere else while the composer stays open over the task.
  card("Focus me").element().focus();
  await expect.element(promptField()).not.toHaveFocus();

  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  await userEvent.keyboard("typedafterthekey");
  await expect.element(promptField()).toHaveValue("typedafterthekey");
});
