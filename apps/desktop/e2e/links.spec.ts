import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  addProject,
  createRepo,
  newTaskView,
  openedWindow,
  promptField,
  sessionTab,
  unwrappedScreenText,
} from "./app-helpers.ts";
import { test } from "./fixtures.ts";

/** The document a window URL loads, without the hash route the app navigates by. */
const documentOf = (url: string) => url.split("#")[0];

/**
 * Local links in chat, in the desktop app where the OS browser is the answer for a web link: the
 * fake pi names a workspace path with a line and an ordinary URL, `[editor]` runs `/bin/echo` so the
 * terminal shows the argv it was given, and `shell.openExternal` is recorded in the main process.
 */
test("a file link opens the editor at its line and a web link goes to the OS browser", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.ts"), "const answer = 42;\n");
  // The server reads this at startup: the editor is the echo builtin, whose output is its argv.
  mkdirSync(path.join(stateDir, "config"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "config", "config.toml"),
    '[editor]\ncommand = "/bin/echo {file}:{line}"\n',
  );

  const app = await launchApp({ FAKE_PI_RPC: "links" });
  const window = await openedWindow(app);
  // Record what the shell hands to the OS instead of opening a real browser.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Reflect.set(globalThis, "__opened", opened);
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });

  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);

  // A prompt-created task in chat view: pi is the agent with a driver in this build (chat.spec.ts).
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  await expect(promptField(window)).toBeFocused();
  await window.keyboard.type("Fix the build");
  await newTaskView(window)
    .getByRole("combobox", { name: /^Agent / })
    .click();
  await expect(window.getByLabel("Search agents")).toBeFocused();
  await window.keyboard.type("pi");
  await window.keyboard.press("Enter");
  await expect(newTaskView(window).getByRole("combobox", { name: /^Agent / })).toHaveAccessibleName(
    "Agent pi · native default",
  );
  await newTaskView(window)
    .getByRole("combobox", { name: /^View / })
    .click();
  await expect(window.getByLabel("Search views")).toBeFocused();
  await window.keyboard.type("chat");
  await window.keyboard.press("Enter");
  await promptField(window).click();
  await window.keyboard.press("Enter");

  await expect(sessionTab(window, "pi")).toHaveAttribute("aria-selected", "true");
  const transcript = window.getByRole("log", { name: "Chat transcript" });
  await expect(transcript.getByText("Here is the answer.")).toBeVisible();

  // The URL never loads in the capability-bearing window: the shell hands it to the OS browser,
  // and the app stays on the chat lane it was showing.
  const before = window.url();
  await transcript.getByRole("link", { name: "https://example.com/docs" }).click();
  await expect
    .poll(() =>
      app.evaluate(() => {
        const opened: unknown = Reflect.get(globalThis, "__opened");
        return Array.isArray(opened) ? opened.map(String) : [];
      }),
    )
    .toEqual(["https://example.com/docs"]);
  expect(window.url()).toBe(before);
  await expect(transcript.getByRole("link", { name: "https://example.com/docs" })).toBeVisible();

  // The path in the answer is a link too, and it opens the editor as a terminal in the workspace.
  await transcript.getByRole("link", { name: "src/app.ts:12" }).click();
  await expect
    .poll(() => unwrappedScreenText(window), { timeout: 15_000 })
    .toContain(`${repo}/src/app.ts:12`);
  // Opening the editor changes the route (the new terminal is the current tab) but not the
  // document the app is loaded from: still no navigation away from the capability-bearing window.
  expect(documentOf(window.url())).toBe(documentOf(before));
});
