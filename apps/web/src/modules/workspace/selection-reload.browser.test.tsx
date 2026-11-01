import type { Project, Session, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { createGitRepo } from "../../../test/git-repo.ts";
import { realServerClients, screenText } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";

const { newClient } = realServerClients();
const SIZE = { cols: 80, rows: 24 };
const workspace = () => page.getByRole("navigation", { name: "workspace" });
const sessionTabs = () => page.getByRole("tablist", { name: "Sessions" });
const sessionButton = (name: string) => sessionTabs().getByRole("tab", { name, exact: true });

interface Seeded {
  project: Project;
  task: Task;
  first: Session;
  second: Session;
  firstHref: string;
  secondHref: string;
}

async function seed(secondKind: "shell" | "claude", label?: string): Promise<Seeded> {
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  const project = await api.projects.add({ path: await createGitRepo("repo") });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Two sessions",
    workspace: { type: "new-branch" },
  });
  const first = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const second = await api.sessions.start({ taskId: task.id, kind: secondKind, size: SIZE });
  if (label !== undefined) await api.sessions.setLabel({ id: second.id, label });
  const href = (session: Session) => `/?project=${project.id}&task=${task.id}&entry=${session.id}`;
  return {
    project,
    task,
    first,
    second,
    firstHref: href(first),
    secondHref: href(second),
  };
}

test("a fresh client at a non-first natural session URL selects it after the stores load", async () => {
  const { secondHref } = await seed("claude");
  await renderApp(newClient(), [secondHref]);

  await expect.element(sessionButton("claude")).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionButton("shell")).not.toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => expect(screenText()).toContain("fake claude ready"));
});

test("a fresh client at a renamed non-first session URL selects the row by its label", async () => {
  const { secondHref } = await seed("shell", "deploy shell");
  await renderApp(newClient(), [secondHref]);

  await expect.element(sessionButton("deploy shell")).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionButton("shell")).not.toHaveAttribute("aria-selected", "true");
});

test("route search changes and Back/Forward follow the URL intent", async () => {
  const { firstHref, secondHref } = await seed("shell");
  const screen = await renderApp(newClient(), [firstHref]);

  await expect.element(sessionButton("shell")).toHaveAttribute("aria-selected", "true");
  screen.history.push(secondHref);
  await expect.element(sessionButton("shell 2")).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionButton("shell")).not.toHaveAttribute("aria-selected", "true");

  screen.history.back();
  await expect.element(sessionButton("shell")).toHaveAttribute("aria-selected", "true");
  screen.history.forward();
  await expect.element(sessionButton("shell 2")).toHaveAttribute("aria-selected", "true");
});

test("a URL whose entry was really removed falls back to the first remaining session", async () => {
  const { secondHref, second } = await seed("shell");
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  await setup.connection.api.sessions.remove({ id: second.id });

  await renderApp(newClient(), [secondHref]);

  await expect.element(sessionButton("shell")).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionButton("shell 2")).not.toBeInTheDocument();
});

test("a fresh client at a non-first loose terminal URL selects it", async () => {
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  await api.terminals.create({ size: SIZE });
  const second = await api.terminals.create({ command: "/bin/cat", size: SIZE });

  await renderApp(newClient(), [`/?task=none&entry=${second.id}`]);

  await expect
    .element(workspace().getByRole("button", { name: /^cat · / }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(workspace().getByRole("button", { name: /^sh · / }))
    .not.toHaveAttribute("aria-current");
});
