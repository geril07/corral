import { useState } from "react";
import { VisualIconButton } from "../../common/ui/index.ts";
import { bindingOf, useConfig } from "../keymap/index.ts";
import {
  VISUAL_REVIEW_ROWS,
  VISUAL_REVIEW_SELECTED,
  VISUAL_REVIEW_SETTLED_ROWS,
} from "./visual-fixtures.ts";
import { VisualShellView, type VisualTaskActions } from "./visual-view.tsx";

/**
 * A development-only host for visual states the seeded .dev/ data does not reach. It renders the
 * same `VisualShellView` the product route uses; the fixture rows stay in this file's data and
 * never enter the app's task store.
 */
export function VisualReview() {
  const { config } = useConfig();
  const [selectedId, setSelectedId] = useState(VISUAL_REVIEW_SELECTED);
  const [dark, setDark] = useState(true);
  const binding = bindingOf(config, "toggle-sidebar");
  const renameBinding = bindingOf(config, "rename-task");
  const removeBinding = bindingOf(config, "remove-task");
  const shortcut = binding === null ? undefined : { prefix: config.keys.prefix, binding };
  const renameShortcut =
    renameBinding === null ? undefined : { prefix: config.keys.prefix, binding: renameBinding };
  const removeShortcut =
    removeBinding === null ? undefined : { prefix: config.keys.prefix, binding: removeBinding };
  // The host has no task store: the menu is here to review, so its actions are inert, and with no
  // settle action the card and menu show the documented no-store variant instead of a dead control.
  const actions: VisualTaskActions = {
    onRename: () => undefined,
    onRemove: () => undefined,
    onViewSource: () => undefined,
  };

  if (!import.meta.env.DEV) {
    return (
      <div className="visual-main-empty">
        <span className="visual-main-empty-title">Review host unavailable.</span>
        <span>This fixture host exists only in development builds.</span>
      </div>
    );
  }

  return (
    <>
      <VisualShellView
        rows={VISUAL_REVIEW_ROWS}
        settledRows={VISUAL_REVIEW_SETTLED_ROWS}
        selectedId={selectedId}
        projectsLoaded
        tasksLoaded
        failure={undefined}
        shortcut={shortcut}
        renameShortcut={renameShortcut}
        removeShortcut={removeShortcut}
        taskActions={actions}
        onSelectTask={setSelectedId}
      />
      <div className="visual-review-theme">
        <VisualIconButton
          label={dark ? "Use light theme" : "Use dark theme"}
          icon="palette"
          onClick={() => {
            const next = !dark;
            setDark(next);
            document.documentElement.classList.toggle("dark", next);
          }}
        />
      </div>
    </>
  );
}
