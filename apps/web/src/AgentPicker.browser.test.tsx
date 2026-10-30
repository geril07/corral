import type { AgentKind } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet: a dialog is only reachable once it is positioned
import "./app.css";
import { AgentPicker } from "./AgentPicker.tsx";

const dialog = () => page.getByRole("dialog", { name: "New agent session" });

async function opened() {
  const onPick = vi.fn<(kind: AgentKind) => void>();
  const onClose = vi.fn<() => void>();
  await render(<AgentPicker onPick={onPick} onClose={onClose} />);
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toHaveFocus();
  return { onPick, onClose };
}

test("it lists the four agents with claude highlighted and focused", async () => {
  await opened();

  await expect.element(dialog().getByRole("radio")).toHaveLength(4);
  await expect.element(dialog().getByRole("radio", { name: "codex" })).toBeVisible();
  await expect.element(dialog().getByRole("radio", { name: "pi" })).toBeVisible();
  await expect.element(dialog().getByRole("radio", { name: "opencode" })).toBeVisible();
  await expect.element(dialog().getByRole("radio", { name: "claude" })).toBeChecked();
});

test("a digit picks that agent straight away", async () => {
  const { onPick } = await opened();

  await userEvent.keyboard("3");

  expect(onPick).toHaveBeenCalledExactlyOnceWith("pi");
});

test("arrows move the highlight and Enter picks it", async () => {
  const { onPick } = await opened();

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect.element(dialog().getByRole("radio", { name: "opencode" })).toBeChecked();
  await userEvent.keyboard("{ArrowUp}{Enter}");

  expect(onPick).toHaveBeenCalledExactlyOnceWith("pi");
});

test("Enter alone picks claude, and a digit beyond the list does nothing", async () => {
  const { onPick } = await opened();

  await userEvent.keyboard("5");
  await userEvent.keyboard("0");
  expect(onPick).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");

  expect(onPick).toHaveBeenCalledExactlyOnceWith("claude");
});

test("Escape closes it without picking", async () => {
  const { onPick, onClose } = await opened();

  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onPick).not.toHaveBeenCalled();
});
