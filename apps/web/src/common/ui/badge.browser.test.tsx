import { expect, test } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { Badge } from "./badge.tsx";

test("a badge is the shell's tag: 18 px with the small radius, and a compact one is the footer's 16 px", async () => {
  const screen = await render(
    <div>
      <Badge>enabled · default</Badge>
      <Badge size="compact">alt+a</Badge>
    </div>,
  );

  const [standard, compact] = [...document.querySelectorAll<HTMLElement>('[data-slot="badge"]')];
  if (standard === undefined || compact === undefined) throw new Error("badges did not render");
  expect(standard.getBoundingClientRect().height).toBe(18);
  expect(getComputedStyle(standard).borderRadius).toBe("2px");
  expect(getComputedStyle(standard).fontSize).toBe("11px");
  expect(compact.getBoundingClientRect().height).toBe(16);
  expect(getComputedStyle(compact).borderRadius).toBe("2px");
  await screen.unmount();
});
