import { expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import {
  addProject,
  createRepo,
  newTaskView,
  openedWindow,
  promptField,
  workspace,
} from "./app-helpers.ts";
import { issueResponseFile, test } from "./fixtures.ts";

test("an imported issue keeps its source when the app is opened again", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  writeFileSync(
    issueResponseFile(stateDir),
    JSON.stringify({
      number: 7,
      title: "Imported issue",
      body: "Issue body with <b>text</b> kept as text.",
      url: "https://github.com/acme/app/issues/7",
    }),
  );

  const first = await launchApp();
  const window = await openedWindow(first);
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  const composer = newTaskView(window);
  await expect(promptField(window)).toBeFocused();
  // "From issue…" expands its field in place; the import fills the prompt, not a separate title.
  await composer.getByRole("button", { name: "From issue…" }).click();
  await composer
    .getByRole("textbox", { name: "Issue URL" })
    .fill("https://github.com/acme/app/issues/7");
  await composer.getByRole("button", { name: "Import issue" }).click();
  await expect(composer.getByRole("status")).toContainText("Imported GitHub issue acme/app#7");
  await expect(promptField(window)).toHaveValue(
    "Imported issue\n\nhttps://github.com/acme/app/issues/7",
  );
  await composer.getByRole("button", { name: "Create task" }).click();
  await expect(composer).toBeHidden();

  const openSource = async () => {
    await workspace(window)
      .getByRole("button", { name: "Task actions for Imported issue" })
      .click();
    await window.getByRole("menuitem", { name: "View issue source…" }).click();
  };
  await expect(workspace(window).getByRole("button", { name: /^Imported issue/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await openSource();
  const source = window.getByRole("dialog", { name: "Issue source" });
  await expect(source.getByText("Original issue title")).toBeVisible();
  await expect(source.getByText("Imported issue", { exact: true })).toBeVisible();
  await expect(source.getByText(/Issue body with <b>text<\/b> kept as text\./)).toBeVisible();
  await expect(source.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/acme/app/issues/7",
  );
  await source.getByRole("button", { name: "Close" }).click();
  await first.close();

  const secondWindow = await openedWindow(await launchApp());
  await expect(
    workspace(secondWindow).getByRole("button", { name: /^Imported issue/ }),
  ).toBeVisible();
  await workspace(secondWindow)
    .getByRole("button", { name: "Task actions for Imported issue" })
    .click();
  await secondWindow.getByRole("menuitem", { name: "View issue source…" }).click();
  const reopenedSource = secondWindow.getByRole("dialog", { name: "Issue source" });
  await expect(reopenedSource.getByText("Original issue title")).toBeVisible();
  await expect(reopenedSource.getByText("Imported issue", { exact: true })).toBeVisible();
});
