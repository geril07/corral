import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { DiffView } from "./diff-view.tsx";

const patchFor = (path: string, lines: number) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${lines} +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => ` line ${index + 1}`),
    "",
  ].join("\n");

function diffRoot(): ShadowRoot {
  const root = document.querySelector("diffs-container")?.shadowRoot;
  if (root === null || root === undefined) throw new Error("the diff has not rendered yet");
  return root;
}

test("a diff over 20 content lines folds at 20 fully visible line boxes and expands on demand", async () => {
  await render(
    <div className="h-screen w-full">
      <DiffView text={patchFor("src/auth.test.ts", 40)} path="src/auth.test.ts" />
    </div>,
  );
  await vi.waitFor(() =>
    expect(document.querySelector("diffs-container")?.shadowRoot).toBeTruthy(),
  );

  // Repeated file headers are not line boxes, so the button names 40, not 44.
  const showAll = document.querySelector<HTMLButtonElement>("button");
  await vi.waitFor(() => expect(showAll?.textContent).toContain("Show all 40 lines"));

  const body = document.querySelector<HTMLElement>('[data-testid="diff-body"]');
  if (body === null) throw new Error("diff body missing");
  // 20 × 20 px line boxes plus the 8 px top padding of the code surface.
  expect(getComputedStyle(body).maxHeight).toBe("408px");

  const shadow = diffRoot();
  await vi.waitFor(() =>
    expect(shadow.querySelectorAll("[data-line-type][data-line]").length).toBeGreaterThan(0),
  );
  const bounds = body.getBoundingClientRect();
  const fullyVisible = [
    ...shadow.querySelectorAll<HTMLElement>("[data-line-type][data-line]"),
  ].filter((row) => {
    const rect = row.getBoundingClientRect();
    return rect.top >= bounds.top - 0.5 && rect.bottom <= bounds.bottom + 0.5;
  }).length;
  expect(fullyVisible).toBe(20);

  await userEvent.click(showAll!);
  await vi.waitFor(() => expect(document.querySelector("button")).toBeNull());
  expect(getComputedStyle(body).maxHeight).toBe("none");
  expect(body.getBoundingClientRect().height).toBeGreaterThan(408);
});
