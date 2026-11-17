import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { Input } from "./input.tsx";

test("a field is the shell's input: 28 px, the control radius, the kit's 13 px type", async () => {
  const screen = await render(<Input aria-label="Name" defaultValue="orbital" />);

  const field = page.getByRole("textbox", { name: "Name" }).element();
  const style = getComputedStyle(field);
  expect(field.getBoundingClientRect().height).toBe(28);
  expect(style.borderRadius).toBe("6px");
  expect(style.fontSize).toBe("13px");
  await screen.unmount();
});

test("a field marks focus, an invalid one paints its placeholder, and a disabled one fades", async () => {
  const screen = await render(
    <div>
      <Input aria-label="Plain" placeholder="Plain" />
      <Input aria-label="Invalid" aria-invalid placeholder="Paste" />
      <Input aria-label="Off" disabled />
    </div>,
  );

  const plain = page.getByRole("textbox", { name: "Plain" }).element();
  expect(getComputedStyle(plain).outlineColor).toBe("rgba(0, 0, 0, 0)");
  plain.focus();
  expect(getComputedStyle(plain).outlineStyle).toBe("solid");
  expect(getComputedStyle(plain).outlineColor).not.toBe("rgba(0, 0, 0, 0)");

  // The invalid frame paints the text it explains, placeholder included.
  const invalid = page.getByRole("textbox", { name: "Invalid" }).element();
  expect(getComputedStyle(invalid, "::placeholder").color).toBe(getComputedStyle(invalid).color);

  const off = page.getByRole("textbox", { name: "Off" }).element();
  expect(getComputedStyle(off).opacity).toBe("0.5");
  await screen.unmount();
});
