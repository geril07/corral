import type { Project } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { ProjectChoiceDialog } from "./project-choice-dialog.tsx";

const project = (
  id: string,
  name: string,
  path: string,
  pinnedAt: number | null = null,
): Project => ({
  id,
  name,
  path,
  defaultBaseBranch: "main",
  pinnedAt,
});

const alpha = project("alpha", "alpha", "/repos/alpha");
const beta = project("beta", "beta", "/repos/beta");
const pinnedBeta = project("beta", "beta", "/repos/beta", 1);

async function renderDialog(
  projects: readonly Project[],
  overrides: Partial<Parameters<typeof ProjectChoiceDialog>[0]> = {},
) {
  const onChoose = vi.fn<(projectId: string | null) => void>();
  const onSetPinned = vi.fn<(id: string, pinned: boolean) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const onClose = vi.fn<() => void>();
  const screen = await render(
    <ProjectChoiceDialog
      projects={projects}
      onChoose={onChoose}
      onSetPinned={onSetPinned}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { screen, onChoose, onSetPinned, onClose };
}

const search = () => page.getByRole("combobox", { name: "Search projects" });
const choose = (name: string) => page.getByRole("option", { name, exact: true });
const list = () => page.getByRole("listbox", { name: "Projects" });
const highlightedName = () =>
  list().element().querySelector<HTMLElement>("[data-highlighted]")?.getAttribute("aria-label");
const expectHighlight = (name: string) => vi.waitFor(() => expect(highlightedName()).toBe(name));
const optionNames = () =>
  [...list().element().querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
    option.getAttribute("aria-label"),
  );

test("search filters locally by name and path and keeps No project", async () => {
  const { screen } = await renderDialog([alpha, beta]);
  await expect.element(search()).toHaveFocus();
  expect(optionNames()).toEqual(["No project", "alpha", "beta"]);

  await userEvent.fill(search(), "bet");
  expect(optionNames()).toEqual(["No project", "beta"]);
  await userEvent.fill(search(), "/repos/alpha");
  expect(optionNames()).toEqual(["No project", "alpha"]);
  await userEvent.fill(search(), "nothing matches");
  expect(optionNames()).toEqual(["No project"]);
  await expect.element(page.getByText(/No projects found/)).not.toBeInTheDocument();
  await screen.unmount();
});

test("no projects and no matching query show only the No project row, with no empty message", async () => {
  const empty = await renderDialog([]);
  expect(optionNames()).toEqual(["No project"]);
  await expect.element(page.getByText(/No projects found/)).not.toBeInTheDocument();
  expect(document.querySelector('[data-slot="path-picker-message"]')).toBeNull();
  await empty.screen.unmount();

  const { screen } = await renderDialog([alpha, beta]);
  await userEvent.fill(search(), "nothing matches");
  expect(optionNames()).toEqual(["No project"]);
  await expect.element(page.getByText(/No projects found/)).not.toBeInTheDocument();
  expect(document.querySelector('[data-slot="path-picker-message"]')).toBeNull();
  await screen.unmount();
});

test("pinned projects stay on top of the project rows, after No project", async () => {
  const { screen } = await renderDialog([alpha, pinnedBeta]);
  expect(optionNames()).toEqual(["No project", "beta", "alpha"]);
  await userEvent.fill(search(), "a");
  expect(optionNames()).toEqual(["No project", "beta", "alpha"]);
  await userEvent.fill(search(), "alpha");
  expect(optionNames()).toEqual(["No project", "alpha"]);
  await screen.unmount();
});

test("ArrowDown and ArrowUp walk the whole list in order and wrap at both ends", async () => {
  const { screen } = await renderDialog([alpha, pinnedBeta]);
  await expect.element(search()).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}");
  await expectHighlight("No project");
  await userEvent.keyboard("{ArrowDown}");
  await expectHighlight("beta");
  await userEvent.keyboard("{ArrowDown}");
  await expectHighlight("alpha");
  // One more down from the last row lands on the first instead of parking on the field.
  await userEvent.keyboard("{ArrowDown}");
  await expectHighlight("No project");
  // Up from the first row lands on the last one.
  await userEvent.keyboard("{ArrowUp}");
  await expectHighlight("alpha");
  await expect.element(search()).toHaveFocus();
  await screen.unmount();
});

test("Enter chooses the highlighted project", async () => {
  const { onChoose, screen } = await renderDialog([alpha, pinnedBeta]);
  await expect.element(search()).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  await expectHighlight("beta");
  await userEvent.keyboard("{Enter}");
  expect(onChoose).toHaveBeenLastCalledWith("beta");
  await screen.unmount();
});

test("Enter chooses the No project row", async () => {
  const { onChoose, screen } = await renderDialog([alpha, pinnedBeta]);
  await expect.element(search()).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expectHighlight("No project");
  await userEvent.keyboard("{Enter}");
  expect(onChoose).toHaveBeenLastCalledWith(null);
  await screen.unmount();
});

test("Enter without a highlight does nothing", async () => {
  const { onChoose, screen } = await renderDialog([alpha]);
  await expect.element(search()).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(onChoose).not.toHaveBeenCalled();
  await screen.unmount();
});

test("typing clears the highlight, so Enter cannot press a stale row", async () => {
  const { onChoose, screen } = await renderDialog([alpha, beta]);
  await expect.element(search()).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expectHighlight("No project");
  await userEvent.type(search(), "alp");
  await vi.waitFor(() => expect(highlightedName()).toBeUndefined());
  expect(optionNames()).toEqual(["No project", "alpha"]);
  await userEvent.keyboard("{Enter}");
  expect(onChoose).not.toHaveBeenCalled();
  await screen.unmount();
});

test("the highlighted row scrolls into view and the long list scrolls inside its frame", async () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    project(`p${index}`, `project-${index}`, `/repos/project-${index}`),
  );
  const { screen } = await renderDialog(many);
  await expect.element(search()).toHaveFocus();
  const listElement = list().element();
  expect(listElement.scrollHeight).toBeGreaterThan(listElement.clientHeight);
  const dialog = page.getByRole("dialog", { name: "New task" }).element();
  expect(dialog.scrollHeight).toBeLessThanOrEqual(dialog.clientHeight + 1);

  await userEvent.keyboard("{ArrowDown}".repeat(21));
  await expectHighlight("project-19");
  await vi.waitFor(() => expect(listElement.scrollTop).toBeGreaterThan(0));
  listElement.scrollTop = 0;
  await userEvent.keyboard("{ArrowUp}");
  await expectHighlight("project-18");
  await screen.unmount();
});

test("the search field shows the caret, not a focus ring or outline", async () => {
  const { screen } = await renderDialog([alpha]);
  const field = search().element();
  if (!(field instanceof HTMLInputElement)) throw new Error("the search field is not an input");
  await expect.element(search()).toHaveFocus();
  expect(field.selectionStart).not.toBeNull();
  const style = getComputedStyle(field);
  expect(style.outlineStyle).toBe("none");
  expect(style.boxShadow).toBe("none");
  await screen.unmount();
});

test("pin and unpin call the RPC without choosing the project", async () => {
  const { screen, onChoose, onSetPinned } = await renderDialog([alpha]);
  await userEvent.click(page.getByRole("button", { name: "Pin alpha" }));
  expect(onSetPinned).toHaveBeenCalledExactlyOnceWith("alpha", true);
  expect(onChoose).not.toHaveBeenCalled();

  await screen.rerender(
    <ProjectChoiceDialog
      projects={[{ ...alpha, pinnedAt: 1 }]}
      onChoose={onChoose}
      onSetPinned={onSetPinned}
      onClose={() => undefined}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Unpin alpha" }));
  expect(onSetPinned).toHaveBeenLastCalledWith("alpha", false);
  expect(onChoose).not.toHaveBeenCalled();
  await screen.unmount();
});

test("Enter on a focused pin toggles the pin and never chooses the project", async () => {
  const { screen, onChoose, onSetPinned } = await renderDialog([alpha]);
  const pin = page.getByRole("button", { name: "Pin alpha" });
  pin.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onSetPinned).toHaveBeenCalledExactlyOnceWith("alpha", true);
  expect(onChoose).not.toHaveBeenCalled();
  await screen.unmount();
});

test("a failed pin keeps the confirmed state and says why", async () => {
  const onSetPinned = vi.fn<(id: string, pinned: boolean) => Promise<void>>(() =>
    Promise.reject(new Error("the server is gone")),
  );
  const { screen } = await renderDialog([alpha], { onSetPinned });
  await userEvent.click(page.getByRole("button", { name: "Pin alpha" }));
  await expect.element(page.getByText("Could not pin project", { exact: true })).toBeVisible();
  await expect.element(page.getByText("the server is gone", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Pin alpha" })).toBeVisible();
  await screen.unmount();
});

test("pin actions stay hidden until the row is hovered or the pin is focused", async () => {
  const { screen } = await renderDialog([alpha]);
  const pin = page.getByRole("button", { name: "Pin alpha" });
  const slot = pin.element().parentElement;
  if (!(slot instanceof HTMLElement)) throw new Error("the pin has no slot");
  // The pointer outlives a test; park it on the field so a previous row hover cannot leak in.
  await userEvent.hover(search());
  await vi.waitFor(() => expect(getComputedStyle(slot).opacity).toBe("0"));

  await userEvent.hover(choose("alpha"));
  await vi.waitFor(() => expect(getComputedStyle(slot).opacity).toBe("1"));
  await userEvent.unhover(choose("alpha"));
  await vi.waitFor(() => expect(getComputedStyle(slot).opacity).toBe("0"));

  pin.element().focus();
  await vi.waitFor(() => expect(getComputedStyle(slot).opacity).toBe("1"));
  await screen.unmount();
});

test("the dialog has no close button; Escape still closes it", async () => {
  const { onClose, screen } = await renderDialog([alpha]);
  await expect.element(page.getByRole("button", { name: "Close" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  await screen.unmount();
});

test("No project leads the list, has no description, and chooses the scratch workspace", async () => {
  const { onChoose, screen } = await renderDialog([alpha, beta]);
  expect(optionNames()[0]).toBe("No project");
  await expect.element(choose("No project")).toHaveTextContent("No project");
  await expect
    .element(page.getByText("A scratch workspace outside any project", { exact: true }))
    .not.toBeInTheDocument();
  await choose("No project").click();
  expect(onChoose).toHaveBeenCalledExactlyOnceWith(null);
  await screen.unmount();
});

test("the Add project frame carries the field, the label and the list", async () => {
  const { screen } = await renderDialog([alpha]);
  const field = search().element();
  expect(field.closest(".visual-path-input-row")).not.toBeNull();
  expect(field.className).toContain("visual-path-input");
  expect(document.querySelectorAll(".visual-path-list-frame")).toHaveLength(1);
  expect(list().element().className).toContain("visual-path-list");
  await userEvent.fill(search(), "nothing matches");
  expect(document.querySelector('[data-slot="path-picker-message"]')).toBeNull();
  await screen.unmount();
});

test("the field takes plain letters, / and digits instead of hotkeys", async () => {
  const { onChoose, screen } = await renderDialog([alpha, beta]);
  await expect.element(search()).toHaveFocus();
  await userEvent.keyboard("2/b");
  await expect.element(search()).toHaveValue("2/b");
  expect(optionNames()).toEqual(["No project"]);
  expect(onChoose).not.toHaveBeenCalled();
  await screen.unmount();
});
