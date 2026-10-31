import type { CreateTaskInput, Project } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { NewTaskDialog } from "./new-task-dialog.tsx";

const project: Project = {
  id: "p1",
  name: "repo",
  path: "/repos/repo",
  defaultBaseBranch: "main",
};

const otherProject: Project = {
  id: "p2",
  name: "other",
  path: "/repos/other",
  defaultBaseBranch: "trunk",
};

const dialog = () => page.getByRole("dialog", { name: "New task" });
// Keys typed before the dialog has taken the focus would go to the page behind it.
const opened = async () => {
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveFocus();
};

function renderDialog(
  branches: Promise<string[]> = Promise.resolve(["main", "feature/x", "origin/dev"]),
  projects: Project[] = [project],
) {
  const onCreate = vi.fn<(input: CreateTaskInput) => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  const loadBranches = vi.fn<(projectId: string) => Promise<string[]>>(() => branches);
  const rendered = render(
    <NewTaskDialog
      projects={projects}
      project={project}
      loadBranches={loadBranches}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );
  return { rendered, onCreate, onClose, loadBranches };
}

test("a title and Enter create a task on a new branch with the project's defaults", async () => {
  const { rendered, onCreate } = renderDialog();
  await rendered;
  await opened();
  await userEvent.keyboard("Fix login");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Fix login",
      workspace: { type: "new-branch" },
    }),
  );
});

test("nothing is created without a title", async () => {
  const { rendered, onCreate } = renderDialog();
  await rendered;
  await opened();

  await expect.element(dialog().getByRole("button", { name: "Create task" })).toBeDisabled();
  await userEvent.keyboard("   {Enter}");
  expect(onCreate).not.toHaveBeenCalled();
});

test("a branch name and a base branch are sent when given", async () => {
  const { rendered, onCreate } = renderDialog();
  await rendered;
  await opened();

  await userEvent.keyboard("Try it");
  await userEvent.fill(dialog().getByRole("textbox", { name: "Branch name (optional)" }), "try-it");
  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Base branch (optional)" }),
    "origin/dev",
  );
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Try it",
      workspace: { type: "new-branch", branch: "try-it", baseBranch: "origin/dev" },
    }),
  );
});

test("the main worktree needs nothing but a title", async () => {
  const { rendered, onCreate } = renderDialog();
  await rendered;
  await opened();

  await userEvent.keyboard("Quick look");
  await dialog().getByRole("radio", { name: "Main worktree" }).click();
  await expect.element(dialog()).toMatchTextContent("/repos/repo");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Quick look",
      workspace: { type: "main-worktree" },
    }),
  );
});

test("an existing branch is picked from the list with the keyboard", async () => {
  const { rendered, onCreate } = renderDialog();
  await rendered;
  await opened();

  await userEvent.keyboard("Continue work");
  await dialog().getByRole("radio", { name: "Existing branch" }).click();
  await expect.element(dialog().getByRole("radio", { name: "Existing branch" })).toBeChecked();
  const branch = dialog().getByRole("combobox", { name: "Branch", exact: true });
  await expect.element(dialog().getByRole("button", { name: "Create task" })).toBeDisabled();

  await userEvent.click(branch);
  await expect
    .element(dialog().getByRole("combobox", { name: "Branch", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("feat");
  await expect.element(page.getByRole("option", { name: "feature/x" })).toBeVisible();
  await expect.element(page.getByRole("option", { name: "main" })).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(branch).toHaveValue("feature/x");

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Continue work",
      workspace: { type: "existing-branch", branch: "feature/x" },
    }),
  );
});

test("the project field starts on the selected project and another project can take the task", async () => {
  const { rendered, onCreate, loadBranches } = renderDialog(
    Promise.resolve(["main", "feature/x"]),
    [project, otherProject],
  );
  await rendered;
  await opened();

  const picker = dialog().getByRole("combobox", { name: "Project", exact: true });
  await expect.element(picker).toHaveValue("repo");
  expect(loadBranches).toHaveBeenLastCalledWith("p1");

  await userEvent.keyboard("Elsewhere");
  await userEvent.fill(picker, "other");
  await expect.element(page.getByRole("option", { name: /other/ })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(picker).toHaveValue("other");
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("Elsewhere");
  expect(loadBranches).toHaveBeenLastCalledWith("p2");

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p2",
      title: "Elsewhere",
      workspace: { type: "new-branch" },
    }),
  );
});

test("a failure to list branches is shown instead of the picker", async () => {
  const { rendered } = renderDialog(Promise.reject(new Error("git exploded")));
  await rendered;
  await opened();

  await dialog().getByRole("radio", { name: "Existing branch" }).click();

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("git exploded");
});

test("a failure to create stays in the dialog", async () => {
  const onCreate = vi.fn<(input: CreateTaskInput) => Promise<void>>(() =>
    Promise.reject(new Error("fatal: invalid reference")),
  );
  await render(
    <NewTaskDialog
      projects={[project]}
      project={project}
      loadBranches={() => Promise.resolve([])}
      onCreate={onCreate}
      onClose={() => undefined}
    />,
  );

  await opened();
  await userEvent.keyboard("Broken{Enter}");

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("fatal: invalid reference");
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("Broken");
});
