import { expect, test } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { Kbd, KbdGroup } from "./kbd.tsx";

test("a keycap is the shell's keybind: 14 px tall, the 2 px radius, 11 px caps", async () => {
  const screen = await render(
    <KbdGroup>
      <Kbd>alt+a c</Kbd>
      <Kbd>shift+r</Kbd>
    </KbdGroup>,
  );

  const [first] = [...document.querySelectorAll<HTMLElement>('[data-slot="kbd"]')];
  if (first === undefined) throw new Error("keycaps did not render");
  const style = getComputedStyle(first);
  expect(first.getBoundingClientRect().height).toBe(14);
  expect(style.borderRadius).toBe("2px");
  expect(style.fontSize).toBe("11px");
  expect(style.textTransform).toBe("uppercase");
  await screen.unmount();
});
