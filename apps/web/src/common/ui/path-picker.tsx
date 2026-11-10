import { Toast } from "@base-ui/react/toast";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon.tsx";
import { PickerAutocomplete } from "./picker-autocomplete.tsx";

/** The Add action's shortcut follows whether a folder row is highlighted. */
const shortcutFor = (active: string | undefined) => (active === undefined ? "Enter" : "Ctrl+Enter");

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
  const input = useRef<HTMLInputElement>(null);
  const caretToEnd = useRef(false);
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
    setEpoch((current) => current + 1);
    onChange(path, "picker");
  };
  return (
    <PickerAutocomplete
      label="Directories"
      inputLabel="Repository path"
      placeholder="~/"
      items={paths.map((entry) => entry.path)}
      query={value}
      onQueryChange={(next) => onChange(next, "input")}
      filter={null}
      itemToStringValue={(path) => path}
      itemLabel={(path) => paths.find((entry) => entry.path === path)?.name ?? path}
      renderItem={(path) => (
        <>
          <Icon name="project" />
          <span className="truncate">{paths.find((entry) => entry.path === path)?.name}</span>
        </>
      )}
      renderAction={(active) => (
        <button
          type="button"
          tabIndex={-1}
          className="visual-path-submit"
          aria-label={`Add project (${shortcutFor(active)})`}
          disabled={pending || !value.trim()}
          onMouseDown={(event) => {
            // Keep the input's virtual folder focus when using its trailing action.
            event.preventDefault();
          }}
          onClick={onSubmit}
        >
          <span>{pending ? "Adding…" : "Add"}</span>
          <kbd className="visual-keycap">{shortcutFor(active)}</kbd>
        </button>
      )}
      onChoose={pick}
      onEnter={(active) => {
        if (pending) return;
        if (active !== undefined) pick(active);
        else onSubmit();
      }}
      onClose={onClose}
      onInputKeyDown={(event, active) => {
        if (event.key === "Enter" && event.ctrlKey) {
          event.preventDefault();
          if (!pending) onSubmit();
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
        if (event.key === "Tab" && !event.shiftKey) {
          const candidates = active === undefined ? paths.map((entry) => entry.path) : [active];
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
      inputProps={{ spellCheck: false, autoComplete: "off", "aria-busy": pending }}
      inputRef={input}
      resetKey={epoch}
      message={message}
    />
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
