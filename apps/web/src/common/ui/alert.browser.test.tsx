import { expect, test } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { Alert, AlertDescription } from "./alert.tsx";

test("an alert is the shell's band, and a destructive one takes the error tint", async () => {
  const screen = await render(
    <div>
      <Alert>
        <AlertDescription>Process exited with code 0.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertDescription>The agent stopped.</AlertDescription>
      </Alert>
    </div>,
  );

  const [plain, bad] = [...document.querySelectorAll<HTMLElement>('[data-slot="alert"]')];
  if (plain === undefined || bad === undefined) throw new Error("alerts did not render");
  expect(getComputedStyle(plain).borderRadius).toBe("8px");
  expect(getComputedStyle(plain).fontSize).toBe("13px");
  expect(getComputedStyle(bad).backgroundColor).not.toBe(getComputedStyle(plain).backgroundColor);
  await screen.unmount();
});
