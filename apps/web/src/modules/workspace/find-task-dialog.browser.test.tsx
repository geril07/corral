import type { VisualTaskRow } from "../../common/ui/index.ts";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { FindTaskDialog } from "./find-task-dialog.tsx";

const findDialog = () => page.getByRole("dialog", { name: "Find task" });
const searchInput = () => findDialog().getByRole("combobox", { name: "Search tasks" });
const list = () => findDialog().getByRole("listbox", { name: "Tasks" });
const option = (name: RegExp) => findDialog().getByRole("option", { name });
const highlighted = () => list().element().querySelector<HTMLElement>("[data-highlighted]");

const row = (
  id: string,
  title: string,
  options: {
    project?: string;
    branch?: string | null;
    settled?: boolean;
    status?: VisualTaskRow["status"];
    activityAge?: string;
  } = {},
): VisualTaskRow => {
  const project = options.project ?? "corral";
  const branch = options.branch === undefined ? `corral/${id}` : options.branch;
  const activityAt = 1_700_000_000_000;
  return {
    id,
    title,
    project,
    projectInitial: project[0]!.toUpperCase(),
    workspacePath: `/work/${id}`,
    hasSource: false,
    ...(branch === null ? {} : { copyBranch: branch }),
    ...(options.settled === true ? { settled: true } : {}),
    ...(options.status === undefined ? {} : { status: options.status }),
    activityAt,
    activityAge: options.activityAge ?? "1h",
    metadata: { project, ...(branch === null ? {} : { branch }) },
  };
};

function props(rows: readonly VisualTaskRow[], onOpen = vi.fn<(id: string) => void>()) {
  return {
    rows,
    onOpen,
    onClose: vi.fn<() => void>(),
  };
}

test("opening focuses one search field over one list, and the first row is the visible selection", async () => {
  await render(<FindTaskDialog {...props([row("t1", "Fix login"), row("t2", "Write docs")])} />);

  await expect.element(searchInput()).toHaveFocus();
  // The sr-only title names the dialog for assistive tech; the visible box has no title band.
  const heading = findDialog().getByText("Find task").element().parentElement;
  if (heading === null) throw new Error("the title has no header");
  const headingBox = heading.getBoundingClientRect();
  expect(Math.max(headingBox.width, headingBox.height)).toBeLessThanOrEqual(1);
  expect(document.querySelectorAll('[data-slot="dialog-description"]')).toHaveLength(0);
  expect(findDialog().element().querySelectorAll('[data-slot="dialog-footer"]')).toHaveLength(0);
  expect(findDialog().getByRole("button").elements()).toHaveLength(0);

  await expect.element(list()).toBeVisible();
  // The frame's one label names the group; the field sits under the dialog's own row.
  await expect.element(findDialog().getByText("Tasks", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(highlighted()?.getAttribute("aria-label")).toMatch(/Fix login/));
});

test("typing filters the list and Enter opens the highlighted task", async () => {
  const onOpen = vi.fn<(id: string) => void>();
  const propsFor = props([row("t1", "Fix login"), row("t2", "Write docs")], onOpen);
  await render(<FindTaskDialog {...propsFor} />);
  await expect.element(searchInput()).toHaveFocus();

  await userEvent.keyboard("docs");
  await expect.element(option(/Write docs/)).toBeVisible();
  await expect.element(option(/Fix login/)).not.toBeInTheDocument();
  await vi.waitFor(() => expect(highlighted()?.getAttribute("aria-label")).toMatch(/Write docs/));

  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("t2");
  await vi.waitFor(() => expect(propsFor.onClose).toHaveBeenCalledOnce());
});

test("Arrow keys move the selection and wrap, and Escape closes without opening", async () => {
  const onOpen = vi.fn<(id: string) => void>();
  const propsFor = props([row("t1", "Fix login"), row("t2", "Write docs")], onOpen);
  await render(<FindTaskDialog {...propsFor} />);
  await expect.element(searchInput()).toHaveFocus();

  await vi.waitFor(() => expect(highlighted()?.getAttribute("aria-label")).toMatch(/Fix login/));
  await userEvent.keyboard("{ArrowDown}");
  await vi.waitFor(() => expect(highlighted()?.getAttribute("aria-label")).toMatch(/Write docs/));
  await userEvent.keyboard("{ArrowDown}");
  await vi.waitFor(() => expect(highlighted()?.getAttribute("aria-label")).toMatch(/Fix login/));
  await userEvent.keyboard("{ArrowUp}");
  await vi.waitFor(() => expect(highlighted()?.getAttribute("aria-label")).toMatch(/Write docs/));

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(propsFor.onClose).toHaveBeenCalledOnce());
  expect(onOpen).not.toHaveBeenCalled();
});

test("a scratch task joins the same list as No project and opens with Enter", async () => {
  const scratch = row("t1", "Scratch notes", { project: "No project", branch: null });
  const onOpen = vi.fn<(id: string) => void>();
  const propsFor = props([scratch, row("t2", "Project work")], onOpen);
  await render(<FindTaskDialog {...propsFor} />);
  await expect.element(searchInput()).toHaveFocus();

  await expect.element(option(/Scratch notes/)).toMatchTextContent(/No project/);
  await expect.element(option(/Project work/)).toMatchTextContent(/corral/);

  await userEvent.keyboard("scratch");
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("t1");
  await vi.waitFor(() => expect(propsFor.onClose).toHaveBeenCalledOnce());
});

test("a settled row shows its state, opens with Enter and offers no Continue action", async () => {
  const settled = row("t1", "Old work", { settled: true });
  const onOpen = vi.fn<(id: string) => void>();
  const propsFor = props([settled], onOpen);
  await render(<FindTaskDialog {...propsFor} />);
  await expect.element(searchInput()).toHaveFocus();

  await expect.element(option(/Old work/)).toMatchTextContent(/settled/);
  expect(findDialog().element().textContent).not.toContain("Continue");

  await userEvent.keyboard("{Enter}");
  // Opening a settled task leaves its state alone; starting work is what un-shelves it (#277).
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("t1");
  await vi.waitFor(() => expect(propsFor.onClose).toHaveBeenCalledOnce());
});

test("the dialog follows its rows up to the list's cap, and an empty answer is one row", async () => {
  const many = Array.from({ length: 20 }, (_unused, index) => row(`t${index}`, `Task ${index}`));
  const heights: number[] = [];
  for (const rows of [[row("t1", "One task")], many.slice(0, 4), many, many.slice(0, 19)]) {
    const screen = await render(<FindTaskDialog {...props(rows)} />);
    await expect.element(searchInput()).toHaveFocus();
    const dialog = findDialog().element();
    if (!(dialog instanceof HTMLElement)) throw new Error("the finder is not an element");
    heights.push(dialog.offsetHeight);
    await screen.unmount();
  }

  // One row, four rows, then the cap: adding a row past the cap changes nothing.
  expect(heights[0]!).toBeLessThan(heights[1]!);
  expect(heights[2]!).toBeGreaterThan(heights[1]!);
  expect(heights[3]).toBe(heights[2]);

  const screen = await render(<FindTaskDialog {...props([row("t1", "Fix login")])} />);
  await expect.element(searchInput()).toHaveFocus();
  await userEvent.keyboard("zz");
  await expect.element(findDialog().getByText("No results found")).toBeVisible();
  const empty = findDialog().element();
  if (!(empty instanceof HTMLElement)) throw new Error("the finder is not an element");
  // An empty answer is one centered line in place of the list, shorter than a one-row list.
  expect(empty.offsetHeight).toBeLessThan(heights[0]!);
  const line = findDialog().element().querySelector('[data-slot="picker-empty"]');
  if (!(line instanceof HTMLElement)) throw new Error("the empty answer has no line");
  expect(line.getBoundingClientRect().height).toBeLessThanOrEqual(40);
  expect(findDialog().getByRole("listbox").elements()).toHaveLength(0);
  await screen.unmount();
});

test("a row shows the recorded branch beside its project, and an unbranched task shows only the project", async () => {
  const branched = row("t1", "Archived work");
  const detached = row("t2", "Detached work", { branch: null });
  await render(<FindTaskDialog {...props([branched, detached])} />);

  await expect.element(option(/Archived work/)).toMatchTextContent(/corral · corral\/t1/);
  expect(
    option(/Archived work/)
      .element()
      .getAttribute("aria-label"),
  ).toContain("branch corral/t1");

  const plain = option(/Detached work/);
  await expect.element(plain).toMatchTextContent(/corral/);
  await expect.element(plain).not.toMatchTextContent(/corral\/t2|HEAD|no branch/);
  expect(plain.element().getAttribute("aria-label")).not.toMatch(/branch /);
});

test("the status the sidebar shows for a task rides its finder row, with one age per row", async () => {
  await render(
    <FindTaskDialog
      {...props([
        row("t1", "Busy task", {
          status: { tone: "working", label: "Working" },
          activityAge: "4m",
        }),
        row("t2", "Finished task", {
          status: { tone: "done", label: "Done", time: "2m" },
          activityAge: "2m",
        }),
      ])}
    />,
  );

  // The status keeps its label; the row's own age sits at the right for every row.
  await expect.element(option(/Busy task/)).toMatchTextContent(/Working4m/);
  await expect.element(option(/Finished task/)).toMatchTextContent(/Done2m/);
  // A status's own time is not printed twice.
  expect(
    option(/Finished task/)
      .element()
      .textContent?.match(/2m/g),
  ).toHaveLength(1);
});

test("removing the selected task while the search is open falls back to the first remaining one", async () => {
  const beta = row("t2", "Archived beta");
  const alpha = row("t1", "Archived alpha");
  const onOpen = vi.fn<(id: string) => void>();
  const onClose = vi.fn<() => void>();
  const screen = await render(
    <FindTaskDialog {...props([beta, alpha], onOpen)} onClose={onClose} />,
  );
  await expect.element(searchInput()).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}");
  await vi.waitFor(() => expect(highlighted()?.getAttribute("aria-label")).toMatch(/alpha/));

  await screen.rerender(<FindTaskDialog {...props([beta], onOpen)} onClose={onClose} />);
  await expect.element(option(/Archived alpha/)).not.toBeInTheDocument();
  await vi.waitFor(() => expect(highlighted()?.getAttribute("aria-label")).toMatch(/beta/));

  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("t2");
});
