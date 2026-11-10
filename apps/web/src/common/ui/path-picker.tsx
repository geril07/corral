import { Autocomplete } from "@base-ui/react/autocomplete";
import { Toast } from "@base-ui/react/toast";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon.tsx";

/** Free-text server paths, not a select-value combobox. Base UI owns virtual focus. */
export function PathPicker({
  value,
  paths,
  onChange,
  onSubmit,
  onClose,
  message,
  pending,
}: {
  value: string;
  paths: { name: string; path: string }[];
  /** `picker` marks a value the user chose, which lists immediately instead of debouncing. */
  onChange: (path: string, source: "input" | "picker") => void;
  onSubmit: () => void;
  onClose: () => void;
  /** One list row in place of the list: a settled empty result or a settled error. */
  message?: { text: ReactNode; error?: boolean } | undefined;
  pending: boolean;
}) {
  // A highlight belongs to the value it was made for. Once the value moves (typing, Tab, or
  // entering a folder), the next Enter adds that path instead of pressing the old row again.
  const [highlighted, setHighlighted] = useState<{ value: string; path: string }>();
  const highlightedPath =
    highlighted?.value === value && paths.some((entry) => entry.path === highlighted.path)
      ? highlighted.path
      : undefined;
  const shortcut = highlightedPath ? "Ctrl+Enter" : "Enter";
  const input = useRef<HTMLInputElement>(null);
  const caretToEnd = useRef(false);
  const lastArrow = useRef<"up" | "down" | undefined>(undefined);
  // Base UI keeps its active row index across a value change, so entering a folder would leave the
  // sixth row highlighted again. A fresh root per pick resets the highlight and the scroll.
  const [epoch, setEpoch] = useState(0);
  // A picked folder is read from the end: the tail of a long path is what the next choice adds to.
  useLayoutEffect(() => {
    const element = input.current;
    if (element === null || !caretToEnd.current || element.value !== value) return;
    caretToEnd.current = false;
    element.focus();
    element.setSelectionRange(value.length, value.length);
    element.scrollLeft = element.scrollWidth;
  }, [value]);
  const pick = (path: string) => {
    if (path !== value) caretToEnd.current = true;
    setHighlighted(undefined);
    setEpoch((current) => current + 1);
    onChange(path, "picker");
  };
  // Base UI follows the ARIA combobox pattern and parks the highlight on the field at either end.
  // One more press from the field lands on the opposite row; dispatching it here, before paint,
  // makes the list wrap directly instead of stopping on the field.
  const wrap = (key: "ArrowUp" | "ArrowDown") => {
    lastArrow.current = undefined;
    // The first press is still inside Base UI's own handler, so the field is not yet the active
    // row; the follow-up press must wait until that state settles.
    queueMicrotask(() => {
      input.current?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };
  return (
    <Autocomplete.Root
      key={epoch}
      inline
      open
      items={paths.map((entry) => entry.path)}
      filter={null}
      value={value}
      onValueChange={(next) => onChange(next, "input")}
      onItemHighlighted={(path, details) => {
        setHighlighted(path === undefined ? undefined : { value, path });
        if (path !== undefined || details.reason !== "keyboard") return;
        const first = paths[0]?.path;
        const last = paths.at(-1)?.path;
        if (first === undefined || last === undefined || first === last) return;
        if (lastArrow.current === "up" && highlightedPath === first) wrap("ArrowUp");
        else if (lastArrow.current === "down" && highlightedPath === last) wrap("ArrowDown");
      }}
      autoHighlight={false}
      highlightItemOnHover={false}
    >
      <div className="visual-path-input-row flex items-center gap-2 border-b px-4">
        <Autocomplete.Input
          ref={input}
          aria-label="Repository path"
          placeholder="~/"
          spellCheck={false}
          autoComplete="off"
          aria-busy={pending}
          className="visual-path-input h-12 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (!event.ctrlKey && !event.altKey && !event.metaKey) {
              if (event.key === "ArrowUp") lastArrow.current = "up";
              if (event.key === "ArrowDown") lastArrow.current = "down";
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              return;
            }
            if (event.ctrlKey && (event.key === "n" || event.key === "p")) {
              event.preventDefault();
              event.currentTarget.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: event.key === "n" ? "ArrowDown" : "ArrowUp",
                  bubbles: true,
                }),
              );
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (!pending) {
                if (!event.ctrlKey && highlightedPath) pick(highlightedPath);
                else onSubmit();
              }
            }
            if (event.key === "Tab" && !event.shiftKey) {
              const candidates = highlightedPath
                ? [highlightedPath]
                : paths.map((entry) => entry.path);
              let common = Array.from(candidates[0] ?? "");
              for (const candidate of candidates) {
                const characters = Array.from(candidate);
                let length = 0;
                while (length < common.length && common[length] === characters[length]) length++;
                common = common.slice(0, length);
              }
              const completion = common.join("");
              if (completion && completion !== value) {
                event.preventDefault();
                pick(completion);
              }
            }
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          className="visual-path-submit"
          aria-label={`Add project (${shortcut})`}
          disabled={pending || !value.trim()}
          onMouseDown={(event) => {
            // Keep the input's virtual folder focus when using its trailing action.
            event.preventDefault();
          }}
          onClick={onSubmit}
        >
          <span>{pending ? "Adding…" : "Add"}</span>
          <kbd className="visual-keycap">{shortcut}</kbd>
        </button>
      </div>
      <div className="px-4 pt-3 text-xs text-muted-foreground">Directories</div>
      {paths.length > 0 ? (
        <div className="visual-path-list-frame">
          <Autocomplete.List
            className="visual-path-list max-h-72 overflow-y-auto px-2"
            aria-label="Directories"
          >
            {(path: string) => (
              <Autocomplete.Item
                key={path}
                value={path}
                className="flex min-w-0 cursor-default items-center gap-2 rounded-sm px-2 text-sm data-highlighted:bg-accent hover:bg-accent"
                onClick={() => pick(path)}
              >
                <Icon name="project" />
                <span className="truncate">{paths.find((entry) => entry.path === path)?.name}</span>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        </div>
      ) : (
        <div className="visual-path-message-row">
          <div
            className="visual-path-message"
            data-slot="path-picker-message"
            role={message === undefined ? undefined : message.error ? "alert" : "status"}
            data-error={message?.error ? "" : undefined}
          >
            {message && (
              <span title={typeof message.text === "string" ? message.text : undefined}>
                {message.text}
              </span>
            )}
          </div>
        </div>
      )}
    </Autocomplete.Root>
  );
}

export function PickerToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      <>
        {children}
        <Toast.Portal>
          <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
            <PickerToasts />
          </Toast.Viewport>
        </Toast.Portal>
      </>
    </Toast.Provider>
  );
}

function PickerToasts() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className="rounded-lg border border-border bg-popover p-3 text-sm break-words text-popover-foreground shadow-popup data-limited:hidden"
    >
      <Toast.Title />
      <Toast.Description />
    </Toast.Root>
  ));
}

export function usePickerToast() {
  return Toast.useToastManager();
}
