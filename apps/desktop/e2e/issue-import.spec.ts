import { expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { addProject, createRepo, openedWindow, workspace } from "./app-helpers.ts";
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
  await expect(window.getByText("No terminals")).toBeVisible();
  await addProject(window, repo);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  const newTask = window.getByRole("dialog", { name: "New task" });
  await expect(newTask.getByRole("textbox", { name: "Title" })).toBeFocused();
  await newTask
    .getByRole("textbox", { name: "Issue URL" })
    .fill("https://github.com/acme/app/issues/7");
  await newTask.getByRole("button", { name: "Import issue" }).click();
  await expect(newTask.getByRole("status")).toContainText("Imported GitHub issue acme/app#7");
  await expect(newTask.getByRole("textbox", { name: "Title" })).toHaveValue("Imported issue");
  await newTask.getByRole("button", { name: "Create task" }).click();
  await expect(newTask).toBeHidden();

  const sourceButton = () =>
    workspace(window).getByRole("button", { name: "view issue source for Imported issue" });
  await expect(workspace(window).getByRole("button", { name: /^Imported issue/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await sourceButton().click();
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
  const reopenedSourceButton = () =>
    workspace(secondWindow).getByRole("button", {
      name: "view issue source for Imported issue",
    });
  await expect(
    workspace(secondWindow).getByRole("button", { name: /^Imported issue/ }),
  ).toBeVisible();
  await reopenedSourceButton().click();
  const reopenedSource = secondWindow.getByRole("dialog", { name: "Issue source" });
  await expect(reopenedSource.getByText("Original issue title")).toBeVisible();
  await expect(reopenedSource.getByText("Imported issue", { exact: true })).toBeVisible();
});
