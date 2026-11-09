import { Autocomplete } from "@base-ui/react/autocomplete";
import { Toast } from "@base-ui/react/toast";
import { useState, type ReactNode } from "react";
import { Icon } from "./icon.tsx";

/** Free-text server paths, not a select-value combobox. Base UI owns virtual focus. */
export function PathPicker({
  value,
  paths,
  onChange,
  onSubmit,
  onClose,
  status,
  pending,
}: {
  value: string;
  paths: { name: string; path: string }[];
  onChange: (path: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  status?: ReactNode;
  pending: boolean;
}) {
  const [highlighted, setHighlighted] = useState<string>();
  const highlightedPath = paths.find((entry) => entry.path === highlighted)?.path;
  const shortcut = highlightedPath ? "Ctrl+Enter" : "Enter";
  return (
    <Autocomplete.Root
      inline
      open
      items={paths.map((entry) => entry.path)}
      filter={null}
      value={value}
      onValueChange={onChange}
      onItemHighlighted={setHighlighted}
      autoHighlight={false}
      highlightItemOnHover={false}
    >
      <div className="visual-path-input-row flex items-center gap-2 border-b px-4">
        <Autocomplete.Input
          aria-label="Repository path"
          placeholder="~/"
          spellCheck={false}
          autoComplete="off"
          aria-busy={pending}
          className="visual-path-input h-12 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
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
                if (!event.ctrlKey && highlightedPath) onChange(highlightedPath);
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
                onChange(completion);
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
      <div className="px-4 pt-3 pb-2 text-xs text-muted-foreground">Directories</div>
      <Autocomplete.List
        className="visual-path-list max-h-72 overflow-y-auto p-2"
        aria-label="Directories"
      >
        {(path: string) => (
          <Autocomplete.Item
            key={path}
            value={path}
            className="flex min-w-0 cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm data-highlighted:bg-accent hover:bg-accent"
            onClick={() => onChange(path)}
          >
            <Icon name="project" />
            <span className="truncate">{paths.find((entry) => entry.path === path)?.name}</span>
          </Autocomplete.Item>
        )}
      </Autocomplete.List>
      {status && (
        <div role="status" className="px-4 pb-3 text-xs text-muted-foreground">
          {status}
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
