import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { Checkbox } from "./checkbox.tsx";

test("the checkbox is the shell's 16 px square, and checking it turns the box to the accent", async () => {
  const screen = await render(<Checkbox aria-label="Visible" />);
  const box = page.getByRole("checkbox", { name: "Visible" });
  const element = box.element();
  const style = getComputedStyle(element);
  expect(element.getBoundingClientRect().width).toBe(16);
  expect(style.borderRadius).toBe("4px");
  expect(style.boxShadow).toContain("inset");

  const unchecked = style.backgroundColor;
  await userEvent.click(box);
  await expect.element(box).toBeChecked();
  expect(getComputedStyle(element).backgroundColor).not.toBe(unchecked);
  await screen.unmount();
});
