import { afterEach, expect, test, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { Button } from "./button.tsx";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog.tsx";
import { TaskDialog } from "./task-dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

type ReducedMotion = "no-preference" | "reduce";

/** Chromium's media emulation is the only way to change what a CSS media query sees. */
async function emulateMotion(reducedMotion: ReducedMotion) {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: reducedMotion }],
  });
}

/** Clearing the feature list restores the host preference instead of emulating the default. */
async function clearMotion() {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
}

function elementAt(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} has not rendered yet`);
  return element;
}

function animationAt(selector: string) {
  const style = getComputedStyle(elementAt(selector));
  return { name: style.animationName, duration: style.animationDuration };
}

afterEach(async () => {
  await clearMotion();
});

test("a menu enters only when motion is allowed: 150 ms normally, none under reduce", async () => {
  await emulateMotion("reduce");
  await render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );

  await userEvent.click(page.getByRole("button", { name: "Open menu" }));
  const menu = '[data-slot="dropdown-menu-content"]';
  await vi.waitFor(() => expect(document.querySelector(menu)).not.toBeNull());
  // No animation class applies, so no duration is set either.
  expect(animationAt(menu)).toEqual({ name: "none", duration: "0s" });

  await emulateMotion("no-preference");
  await vi.waitFor(() => expect(animationAt(menu).name).toBe("enter"));
  expect(animationAt(menu).duration).toBe("0.15s");
});

test("a dialog and its scrim enter only when motion is allowed: 200 ms normally, none under reduce", async () => {
  await emulateMotion("reduce");
  await render(
    <Dialog>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Rename task</DialogTitle>
      </DialogContent>
    </Dialog>,
  );

  await userEvent.click(page.getByRole("button", { name: "Open dialog" }));
  const dialog = '[data-slot="dialog-content"]';
  const scrim = '[data-slot="dialog-overlay"]';
  await vi.waitFor(() => expect(document.querySelector(dialog)).not.toBeNull());
  expect(animationAt(dialog)).toEqual({ name: "none", duration: "0s" });
  expect(animationAt(scrim)).toEqual({ name: "none", duration: "0s" });

  await emulateMotion("no-preference");
  await vi.waitFor(() => expect(animationAt(dialog).name).toBe("enter"));
  expect(animationAt(dialog).duration).toBe("0.2s");
  expect(animationAt(scrim)).toEqual({ name: "enter", duration: "0.2s" });
});

test("a dialog fades and scales out before it unmounts, on its own compositing layer", async () => {
  await emulateMotion("no-preference");
  await render(
    <Dialog>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Rename task</DialogTitle>
      </DialogContent>
    </Dialog>,
  );

  await userEvent.click(page.getByRole("button", { name: "Open dialog" }));
  const dialog = '[data-slot="dialog-content"]';
  const scrim = '[data-slot="dialog-overlay"]';
  await vi.waitFor(() => expect(document.querySelector(dialog)).not.toBeNull());
  expect(getComputedStyle(elementAt(dialog)).willChange).toBe("transform");

  await userEvent.click(page.getByRole("button", { name: "Close" }));
  await vi.waitFor(() => expect(animationAt(dialog).name).toBe("exit"));
  expect(animationAt(dialog).duration).toBe("0.2s");
  expect(animationAt(scrim)).toEqual({ name: "exit", duration: "0.2s" });
  // The popup leaves the DOM only after the exit animation, so nothing closes with a cut.
  await vi.waitFor(() => expect(document.querySelector(dialog)).toBeNull());
});

test("TaskDialog unmounts its owner only once the exit animation ends", async () => {
  await emulateMotion("no-preference");
  const close = vi.fn<() => void>();
  await render(
    <TaskDialog title="Settings" onClose={close}>
      <button type="button">Save</button>
    </TaskDialog>,
  );
  const dialog = '[data-slot="dialog-content"]';
  await userEvent.click(page.getByRole("button", { name: "Close" }));
  await vi.waitFor(() => expect(animationAt(dialog).name).toBe("exit"));
  // Still mounted while the animation runs, so the caller reacts to close only after it.
  expect(close).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(document.querySelector(dialog)).toBeNull();
});

test("a button does not move while it is pressed", async () => {
  await render(<Button>Save</Button>);
  const button = page.getByRole("button", { name: "Save" }).element();
  const box = button.getBoundingClientRect();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const movement = () => {
    const style = getComputedStyle(button);
    return { transform: style.transform, translate: style.translate };
  };
  const press = (type: "mousePressed" | "mouseReleased") =>
    cdp().send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });

  expect(movement()).toEqual({ transform: "none", translate: "none" });
  // Only a trusted press puts the button in :active, so the check reads the state a user sees.
  await press("mousePressed");
  await vi.waitFor(() => expect(button.matches(":active")).toBe(true));
  expect(movement()).toEqual({ transform: "none", translate: "none" });
  await press("mouseReleased");
});
