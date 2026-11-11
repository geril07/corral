import type { Session, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { createGitRepo } from "../../../test/git-repo.ts";
import { realServerClients, screenText } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";

const { newClient } = realServerClients();
const SIZE = { cols: 80, rows: 24 };
const tab = (name: string | RegExp) =>
  page.getByRole("tablist", { name: "Sessions" }).getByRole("tab", { name });

async function seed(
  secondKind: "shell" | "claude",
  label?: string,
  title = "Two sessions",
): Promise<{
  task: Task;
  second: Session;
  href: string;
}> {
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  const project = await api.projects.add({ path: await createGitRepo("repo") });
  const task = await api.tasks.create({
    projectId: project.id,
    title,
    workspace: { type: "new-branch" },
  });
  await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const second = await api.sessions.start({ taskId: task.id, kind: secondKind, size: SIZE });
  if (label !== undefined) await api.sessions.setLabel({ id: second.id, label });
  return { task, second, href: `/?task=${task.id}` };
}

test("a fresh client restores a selected non-first agent session", async () => {
  const { href } = await seed("claude");
  const first = await renderApp(newClient(), [href]);
  await tab(/^claude/).click();
  await expect.element(tab(/^claude/)).toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => expect(screenText()).toContain("fake claude ready"));
  await first.unmount();

  await renderApp(newClient(), [href]);
  await expect.element(tab(/^claude/)).toHaveAttribute("aria-selected", "true");
  await expect.element(tab(/^shell/)).not.toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => expect(screenText()).toContain("fake claude ready"));
});

test("a fresh client restores a selected renamed non-first session", async () => {
  const { href } = await seed("shell", "deploy shell");
  const first = await renderApp(newClient(), [href]);
  await tab(/^deploy shell/).click();
  await expect.element(tab(/^deploy shell/)).toHaveAttribute("aria-selected", "true");
  await first.unmount();

  await renderApp(newClient(), [href]);
  await expect.element(tab(/^deploy shell/)).toHaveAttribute("aria-selected", "true");
  await expect.element(tab(/^shell$/)).not.toHaveAttribute("aria-selected", "true");
});

test("task route changes and Back/Forward follow the task URL", async () => {
  const first = await seed("shell");
  const second = await seed("shell", undefined, "Another task");
  const screen = await renderApp(newClient(), [first.href]);
  await expect.element(page.getByRole("heading", { name: first.task.title })).toBeVisible();
  screen.history.push(second.href);
  await expect.element(page.getByRole("heading", { name: second.task.title })).toBeVisible();
  screen.history.back();
  await expect.element(page.getByRole("heading", { name: first.task.title })).toBeVisible();
  screen.history.forward();
  await expect.element(page.getByRole("heading", { name: second.task.title })).toBeVisible();
});

test("a removed selected session falls back to the remaining session on reopen", async () => {
  const { href, second } = await seed("shell");
  const screen = await renderApp(newClient(), [href]);
  await tab(/^shell 2/).click();
  await expect.element(tab(/^shell 2/)).toHaveAttribute("aria-selected", "true");
  await screen.unmount();
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  await setup.connection.api.sessions.remove({ id: second.id });

  await renderApp(newClient(), [href]);
  await expect.element(tab(/^shell$/)).toHaveAttribute("aria-selected", "true");
  await expect.element(tab(/^shell 2/)).not.toBeInTheDocument();
});
