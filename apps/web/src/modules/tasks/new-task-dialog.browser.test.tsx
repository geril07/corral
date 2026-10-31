import type { CreateTaskInput, Project, TaskSource } from "@corral/protocol/rpc";
import { ORPCError } from "@orpc/client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
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

async function chooseProject(name: string) {
  const picker = dialog().getByRole("combobox", { name: /Project/ });
  await userEvent.click(picker);
  await userEvent.fill(picker, name);
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await expect.element(picker).toHaveValue(name);
}

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

for (const [width, height] of [
  [1920, 1080],
  [1024, 640],
] as const) {
  test(`workspace option labels stay in one row at ${width}×${height}`, async () => {
    const original = { width: window.innerWidth, height: window.innerHeight };
    try {
      await page.viewport(width, height);
      await renderDialog().rendered;
      await opened();
      const labels = ["New branch", "Existing branch", "Main worktree"].map((name) => {
        const label = dialog().getByRole("radio", { name, exact: true }).element().closest("label");
        if (!label) throw new Error(`Missing workspace option label: ${name}`);
        return label.getBoundingClientRect();
      });
      const first = labels[0]!;
      for (const label of labels) {
        expect(Math.abs(label.top - first.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(label.bottom - first.bottom)).toBeLessThanOrEqual(1);
      }
      for (const [index, label] of labels.slice(1).entries()) {
        expect(label.left).toBeGreaterThanOrEqual(labels[index]!.right);
      }
      expect(labels.at(-1)!.right).toBeLessThanOrEqual(width);
    } finally {
      await page.viewport(original.width, original.height);
    }
  });
}

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
  const onResolveIssue = vi.fn<ResolveProjectIssue>(async () => issue);
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
  expect(onResolveIssue.mock.calls[0]?.[1]).toEqual({
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
  const failing = vi.fn<ResolveProjectIssue>(async () => {
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
    .fn<ResolveProjectIssue>()
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
  expect(onResolveIssue.mock.calls[1]?.[1]).toEqual({
    url: "https://gitlab.example.com/group/project/-/issues/3",
    provider: "gitlab",
  });
});

test("Cancel import aborts the request and keeps the form ready to import again", async () => {
  let firstSignal: AbortSignal | undefined;
  const onResolveIssue = vi.fn<ResolveProjectIssue>();
  onResolveIssue.mockImplementationOnce((_projectId, _input, signal) => {
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

test("an auto title does not survive a project switch after a cleared manual title", async () => {
  const { rendered } = renderDialog(undefined, [project, otherProject]);
  await rendered;
  await opened();

  await userEvent.fill(dialog().getByRole("textbox", { name: "Title" }), "Manual");
  await userEvent.fill(dialog().getByRole("textbox", { name: "Title" }), "");
  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("Issue title");

  await chooseProject(otherProject.name);
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("");
});

test("an auto title does not survive a project switch after the source URL was edited away", async () => {
  const { rendered } = renderDialog(undefined, [project, otherProject]);
  await rendered;
  await opened();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("Issue title");
  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/8",
  );
  await expect.element(dialog().getByRole("status")).not.toBeInTheDocument();

  await chooseProject(otherProject.name);
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("");
});

test("an unmounted import cannot clear the next project's pending state", async () => {
  const first = Promise.withResolvers<TaskSource>();
  const second = Promise.withResolvers<TaskSource>();
  const onResolveIssue = vi.fn<ResolveProjectIssue>((projectId) =>
    projectId === project.id ? first.promise : second.promise,
  );
  const { rendered, onCreate } = renderDialog(undefined, [project, otherProject], onResolveIssue);
  await rendered;
  await opened();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("button", { name: "Importing…" })).toBeVisible();

  await chooseProject(otherProject.name);
  await userEvent.fill(dialog().getByRole("textbox", { name: "Title" }), "Manual B");
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("Manual B");
  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/8",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("button", { name: "Importing…" })).toBeVisible();

  const secondIssue: TaskSource = {
    ...issue,
    number: 8,
    url: "https://github.com/acme/app/issues/8",
    title: "B issue",
  };
  expect(onResolveIssue.mock.calls.map((call) => call[0])).toEqual(["p1", "p2"]);
  first.resolve(issue);
  await first.promise;
  // Let the unmounted A continuation run before checking B is still busy.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect.element(dialog().getByRole("button", { name: "Importing…" })).toBeVisible();
  await expect.element(dialog().getByRole("button", { name: "Create task" })).toBeDisabled();

  second.resolve(secondIssue);
  await expect
    .element(dialog().getByRole("status"))
    .toMatchTextContent("Imported GitHub issue acme/app#8");
  await dialog().getByRole("button", { name: "Create task" }).click();
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: otherProject.id,
      title: "Manual B",
      source: secondIssue,
      workspace: { type: "new-branch" },
    }),
  );
});

test("a result that arrives after switching projects is ignored", async () => {
  const deferred = Promise.withResolvers<TaskSource>();
  const onResolveIssue = vi.fn<ResolveProjectIssue>(() => deferred.promise);
  const { rendered } = renderDialog(undefined, [project, otherProject], onResolveIssue);
  await rendered;
  await opened();

  await userEvent.fill(
    dialog().getByRole("textbox", { name: "Issue URL" }),
    "https://github.com/acme/app/issues/7",
  );
  await dialog().getByRole("button", { name: "Import issue" }).click();
  await expect.element(dialog().getByRole("button", { name: "Importing…" })).toBeVisible();

  const picker = dialog().getByRole("combobox", { name: /Project/ });
  await userEvent.click(picker);
  await userEvent.fill(picker, otherProject.name);
  await page.getByRole("option", { name: new RegExp(otherProject.name) }).click();
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("");

  deferred.resolve(issue);
  await Promise.resolve();
  await expect.element(dialog().getByRole("status")).not.toBeInTheDocument();
  await expect.element(dialog().getByRole("textbox", { name: "Title" })).toHaveValue("");
  expect(onResolveIssue.mock.calls[0]?.[0]).toBe("p1");
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
