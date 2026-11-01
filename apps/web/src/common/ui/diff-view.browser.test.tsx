import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { DiffView } from "./diff-view.tsx";

const fortyLinePatch = [
  "--- src/auth.test.ts",
  "+++ src/auth.test.ts",
  "@@ -1,40 +1,40 @@",
  ...Array.from({ length: 40 }, (_, index) => ` line ${index + 1}`),
  "",
].join("\n");

test("a diff over 20 content lines folds at 20 line boxes and expands on demand", async () => {
  await render(
    <div className="h-screen w-full">
      <DiffView text={fortyLinePatch} path="src/auth.test.ts" />
    </div>,
  );
  await vi.waitFor(() =>
    expect(document.querySelector("diffs-container")?.shadowRoot).toBeTruthy(),
  );

  // Headers and the trailing newline are not line boxes, so the button names 40, not 43.
  const showAll = document.querySelector<HTMLButtonElement>("button");
  await vi.waitFor(() => expect(showAll?.textContent).toContain("Show all 40 lines"));

  const body = document.querySelector<HTMLElement>('[data-testid="diff-body"]');
  if (body === null) throw new Error("diff body missing");
  // 20 boxes x the 20 px line @pierre/diffs renders, applied by the kit's max-height step.
  expect(getComputedStyle(body).maxHeight).toBe("400px");
  expect(body.getBoundingClientRect().height).toBeLessThanOrEqual(401);

  await userEvent.click(showAll!);
  await vi.waitFor(() => expect(document.querySelector("button")).toBeNull());
  expect(getComputedStyle(body).maxHeight).toBe("none");
  expect(body.getBoundingClientRect().height).toBeGreaterThan(400);
});
