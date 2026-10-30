import type { CreateTaskInput, Project, TaskSource } from "@corral/protocol/rpc";
import { ORPCError } from "@orpc/client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import type { ResolveIssue } from "./issue-import.tsx";
import { NewTaskDialog } from "./new-task-dialog.tsx";

const issue: TaskSource = {
  provider: "github",
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/issues/7",
  title: "Issue title",
  body: "Issue body",
  fetchedAt: 1_700_000_000_000,
};

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

type ResolveProjectIssue = (
  projectId: string,
  input: { url: string; provider?: "github" | "gitlab" | undefined },
  signal: AbortSignal,
) => Promise<TaskSource>;

function renderDialog(
  branches: Promise<string[]> = Promise.resolve(["main", "feature/x", "origin/dev"]),
  projects: Project[] = [project],
  onResolveIssue: ResolveProjectIssue = vi.fn<ResolveProjectIssue>(async () => issue),
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
      onResolveIssue={onResolveIssue}
      onClose={onClose}
    />,
  );
  return { rendered, onCreate, onResolveIssue, onClose, loadBranches };
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
      onResolveIssue={async () => issue}
      onClose={() => undefined}
    />,
  );

  await opened();
  await userEvent.keyboard("Broken{Enter}");

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("fatal: invalid reference");
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("Broken");
});

test("an issue is read only from the explicit Import action, then its title becomes the default", async () => {
  const onResolveIssue = vi.fn<ResolveIssue>(async () => issue);
  const { rendered, onCreate } = renderDialog(undefined, undefined, onResolveIssue);
  await rendered;
  await opened();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  expect(onResolveIssue).not.toHaveBeenCalled();

  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect
    .element(dialog().getByRole("status"))
    .toMatchTextContent("Imported GitHub issue acme/app#7");
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("Issue title");
  expect(onResolveIssue.mock.calls[0]?.[0]).toEqual({
    url: "https://github.com/acme/app/issues/7",
  });

  await dialog().getByRole("button", { name: "Create task" }).click();
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Issue title",
      source: issue,
      workspace: { type: "new-branch" },
    }),
  );
});

test("a title typed by the user is not overwritten by the issue, and the source keeps the original title", async () => {
  const { rendered, onCreate } = renderDialog();
  await rendered;
  await opened();

  await userEvent.keyboard("My wording");
  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("status")).toBeVisible();
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("My wording");

  await dialog().getByRole("button", { name: "Create task" }).click();
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "My wording",
      source: issue,
      workspace: { type: "new-branch" },
    }),
  );
});

test("an import failure leaves the form usable and creates a plain task without a source", async () => {
  const failing = vi.fn<ResolveIssue>(async () => {
    throw new Error("issue tool unavailable");
  });
  const { rendered, onCreate } = renderDialog(undefined, undefined, failing);
  await rendered;
  await opened();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("alert")).toMatchTextContent("issue tool unavailable");
  await expect.element(dialog().getByRole("button", { name: "Import issue" })).toBeEnabled();
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("");

  await userEvent.fill(dialog().getByRole("textbox", { name: "Title" }), "Manual task");
  await dialog().getByRole("button", { name: "Create task" }).click();
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Manual task",
      workspace: { type: "new-branch" },
    }),
  );
});

test("a self-hosted host asks for its provider before the second Import", async () => {
  const selfHosted: TaskSource = {
    ...issue,
    provider: "gitlab",
    host: "gitlab.example.com",
    repository: "group/project",
    number: 3,
    url: "https://gitlab.example.com/group/project/-/issues/3",
    title: "Self hosted issue",
  };
  const onResolveIssue = vi
    .fn<ResolveIssue>()
    .mockRejectedValueOnce(
      new ORPCError("ISSUE_PROVIDER_REQUIRED", {
        defined: true,
        data: { host: "gitlab.example.com" },
      }),
    )
    .mockResolvedValueOnce(selfHosted);
  const { rendered } = renderDialog(undefined, undefined, onResolveIssue);
  await rendered;
  await opened();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://gitlab.example.com/group/project/-/issues/3",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect
    .element(dialog().getByText("gitlab.example.com could be GitHub or GitLab"))
    .toBeVisible();
  await expect.element(dialog().getByRole("button", { name: "Import issue" })).toBeDisabled();

  await dialog().getByRole("radio", { name: "GitLab" }).click();
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("status")).toMatchTextContent("Imported GitLab issue");
  expect(onResolveIssue.mock.calls[1]?.[0]).toEqual({
    url: "https://gitlab.example.com/group/project/-/issues/3",
    provider: "gitlab",
  });
});

test("Cancel import aborts the request and keeps the form ready to import again", async () => {
  let firstSignal: AbortSignal | undefined;
  const onResolveIssue = vi.fn<ResolveIssue>();
  onResolveIssue.mockImplementationOnce((_input, signal) => {
    firstSignal = signal;
    return new Promise<TaskSource>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  onResolveIssue.mockResolvedValueOnce(issue);
  const { rendered } = renderDialog(undefined, undefined, onResolveIssue);
  await rendered;
  await opened();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("button", { name: "Importing…" })).toBeVisible();
  await dialog().getByRole("button", { name: "Cancel import" }).click();

  await expect.element(dialog().getByRole("button", { name: "Import issue" })).toBeVisible();
  expect(firstSignal?.aborted).toBe(true);
  await expect.element(dialog().getByRole("alert")).not.toBeInTheDocument();

  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("Issue title");
});

test("editing the URL after an import drops the stale source", async () => {
  const { rendered, onCreate } = renderDialog();
  await rendered;
  await opened();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("status")).toBeVisible();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/8",
  );
  await expect.element(dialog().getByRole("status")).not.toBeInTheDocument();
  await dialog().getByRole("button", { name: "Create task" }).click();
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Issue title",
      workspace: { type: "new-branch" },
    }),
  );
});
