import { ORPCError } from "@orpc/client";
import type { Session } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet: a dialog is only reachable once it is positioned
import "./app.css";
import { RemoveSessionDialog } from "./RemoveSessionDialog.tsx";

const session: Session = {
  id: "s1",
  taskId: "t1",
  kind: "claude",
  agentSessionId: "abc",
  terminalId: "term",
  state: "running",
  status: null,
  createdAt: 0,
};

const dialog = () => page.getByRole("alertdialog");
const button = (name: string) => dialog().getByRole("button", { name });

test("it starts on Cancel, so a stray Enter removes nothing, and says the agent's history stays", async () => {
  const onRemove = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  await render(<RemoveSessionDialog session={session} onRemove={onRemove} onClose={onClose} />);

  await expect.element(button("Cancel")).toHaveFocus();
  await expect.element(dialog()).toMatchTextContent("conversation history is left alone");

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onRemove).not.toHaveBeenCalled();
});

test("Tab then Enter removes it", async () => {
  const onRemove = vi.fn<() => Promise<void>>(() => Promise.resolve());
  await render(
    <RemoveSessionDialog session={session} onRemove={onRemove} onClose={() => undefined} />,
  );

  await expect.element(button("Cancel")).toHaveFocus();
  await userEvent.keyboard("{Tab}{Enter}");

  await vi.waitFor(() => expect(onRemove).toHaveBeenCalledOnce());
});

test("a shell has no conversation to mention, and a refusal is shown in the dialog", async () => {
  const onRemove = vi.fn<() => Promise<void>>(() =>
    Promise.reject(new ORPCError("SESSION_NOT_FOUND", { defined: true, data: { id: "s1" } })),
  );
  await render(
    <RemoveSessionDialog
      session={{ ...session, kind: "shell", agentSessionId: null }}
      onRemove={onRemove}
      onClose={() => undefined}
    />,
  );

  await expect.element(dialog()).not.toMatchTextContent("conversation");
  await expect.element(button("Cancel")).toHaveFocus();
  await userEvent.keyboard("{Tab}{Enter}");

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("no longer exists");
});
