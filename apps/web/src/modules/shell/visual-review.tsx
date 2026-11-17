import { useMemo, useState } from "react";
import { Button, VisualIconButton } from "../../common/ui/index.ts";
import { bindingOf, useConfig } from "../keymap/index.ts";
import { mockSettledRows, VISUAL_REVIEW_ROWS, VISUAL_REVIEW_SELECTED } from "./visual-fixtures.ts";
import { VisualShellView, type VisualTaskActions } from "./visual-view.tsx";

/** Mock shelf sizes: none, one page, two pages, and a history that keeps Show more in reach. */
const MOCK_SETTLED_COUNTS = [0, 10, 40, 120] as const;
const INITIAL_MOCK_SETTLED = 40;
const SHELF_KEY = "corral.sidebar-shelf";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The review host starts with the shelf open unless this device already said otherwise. */
function initialShelfOpen(): boolean {
  try {
    const saved = window.localStorage.getItem(SHELF_KEY);
    if (saved === null) {
      window.localStorage.setItem(SHELF_KEY, JSON.stringify({ expanded: true }));
      return true;
    }
    const parsed: unknown = JSON.parse(saved);
    return isRecord(parsed) && parsed.expanded === true;
  } catch {
    return false;
  }
}

const REVIEW_SHELF_OPEN = import.meta.env.DEV ? initialShelfOpen() : false;

/**
 * A development-only host for visual states the seeded .dev/ data does not reach. It renders the
 * same `VisualShellView` the product route uses; the fixture rows stay in this file's data and
 * never enter the app's task store.
 */
export function VisualReview() {
  const { config } = useConfig();
  const [selectedId, setSelectedId] = useState<string | null>(VISUAL_REVIEW_SELECTED);
  const [dark, setDark] = useState(true);
  const [settledCount, setSettledCount] = useState<number>(INITIAL_MOCK_SETTLED);
  const [shelfOpen, setShelfOpen] = useState(REVIEW_SHELF_OPEN);
  const [shelfEpoch, setShelfEpoch] = useState(0);
  const settledRows = useMemo(() => mockSettledRows(settledCount), [settledCount]);
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
  // The shelf reads its expanded bit once, at mount; remounting the shell is how the overlay
  // writes the device preference without a second owner for it.
  const toggleShelf = () => {
    const expanded = !shelfOpen;
    try {
      window.localStorage.setItem(SHELF_KEY, JSON.stringify({ expanded }));
    } catch {
      // The review control still reports the state it asked for; the shell keeps its default.
    }
    setShelfOpen(expanded);
    setShelfEpoch((epoch) => epoch + 1);
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
        key={`${settledCount}:${shelfEpoch}`}
        rows={VISUAL_REVIEW_ROWS}
        settledRows={settledRows}
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
      <div className="visual-review-theme" role="group" aria-label="Review controls">
        <span className="visual-review-label">Settled</span>
        {MOCK_SETTLED_COUNTS.map((count) => (
          <Button
            key={count}
            size="xs"
            variant={count === settledCount ? "secondary" : "ghost"}
            aria-pressed={count === settledCount}
            onClick={() => setSettledCount(count)}
          >
            {count}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={toggleShelf}>
          {shelfOpen ? "Close shelf" : "Open shelf"}
        </Button>
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
