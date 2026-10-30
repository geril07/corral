import { _electron as electron, expect, test } from "@playwright/test";
import path from "node:path";

// Playwright sends keys over CDP, past native menu handling, so this cannot catch the Alt
// menu-bar problem that main.ts guards against; it covers the app reacting to the prefix.
test("the window shows the app and the prefix chord arms prefix mode", async () => {
  const app = await electron.launch({ args: [path.join(import.meta.dirname, "..")] });
  try {
    const window = await app.firstWindow();
    await expect(window).toHaveTitle("Corral");

    await window.keyboard.press("Alt+KeyA");
    await expect(window.getByRole("status", { name: "prefix mode" })).toBeVisible();
  } finally {
    await app.close();
  }
});
