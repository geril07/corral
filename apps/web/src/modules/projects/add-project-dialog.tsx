import { describeError } from "@corral/client/rpc-errors";
import { useEffect, useRef, useState } from "react";
import {
  TaskDialog,
  PathPicker,
  PickerToastProvider,
  usePickerToast,
  useTaskDialogClose,
} from "../../common/ui/index.ts";

/** One round trip per pause, not per keystroke; T3 uses the same 120 ms for path search. */
const BROWSE_DEBOUNCE_MS = 120;

interface DirectoryListing {
  directories: { name: string; path: string }[];
  truncated: boolean;
}

// Reopening the picker, or stepping back into a folder just left, shows the last answer at once
// and revalidates behind it, so the list never starts at zero elements.
const CACHED_LISTINGS = 50;
const listingCache = new Map<string, DirectoryListing>();

function rememberListing(path: string, listing: DirectoryListing) {
  listingCache.delete(path);
  listingCache.set(path, listing);
  if (listingCache.size <= CACHED_LISTINGS) return;
  const oldest = listingCache.keys().next().value;
  if (oldest !== undefined) listingCache.delete(oldest);
}

interface AddProjectDialogProps {
  onAdd: (path: string) => Promise<void>;
  onBrowse: (path: string, signal: AbortSignal) => Promise<DirectoryListing>;
  onClose: () => void;
}

export function AddProjectDialog({ onAdd, onBrowse, onClose }: AddProjectDialogProps) {
  return (
    <PickerToastProvider>
      <TaskDialog
        title="Add project"
        layout="path-picker"
        showCloseButton={false}
        onClose={onClose}
      >
        <ProjectPicker onAdd={onAdd} onBrowse={onBrowse} onClose={onClose} />
      </TaskDialog>
    </PickerToastProvider>
  );
}

function ProjectPicker({
  onAdd,
  onBrowse,
  onClose: onDialogClose,
}: Omit<AddProjectDialogProps, "onClose"> & { onClose: () => void }) {
  const [path, setPath] = useState("~/");
  // The last listing that settled, for whichever path asked for it. It stays on screen while a
  // newer path is in flight, so typing never empties the list.
  const [listing, setListing] = useState<{ path: string; listing: DirectoryListing } | undefined>(
    () => {
      const cached = listingCache.get("~/");
      return cached === undefined ? undefined : { path: "~/", listing: cached };
    },
  );
  /** The message of the last listing that failed; a newer settled listing clears it. */
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState(false);
  // The first listing and a folder the user picked are read at once; only typing waits for the
  // debounce, so choosing a folder never feels like a reload.
  const immediate = useRef(true);
  const submitting = useRef(false);
  const alive = useRef(true);
  const toast = usePickerToast();
  const close = useTaskDialogClose() ?? onDialogClose;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    if (path) {
      const browse = () => {
        void onBrowse(path, controller.signal).then(
          (response) => {
            if (controller.signal.aborted) return;
            rememberListing(path, response);
            setListing({ path, listing: response });
            setFailure(undefined);
          },
          (error: unknown) => {
            if (!controller.signal.aborted) setFailure(describeError(error));
          },
        );
      };
      // Any edit aborts the request for the previous value at once; typing waits for a pause,
      // while the first read and a picked folder go now.
      const wait = !immediate.current;
      immediate.current = false;
      if (wait) timer = window.setTimeout(browse, BROWSE_DEBOUNCE_MS);
      else browse();
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      controller.abort();
    };
  }, [path, onBrowse]);

  // The panel shows the last settled answer — rows, an empty result, or an error — and only a
  // newer settled answer replaces it. Keying any of them to the exact current path made every
  // keystroke fall back to a different state and then flip back when the request settled.
  const failureMessage = failure;
  const directories =
    path !== "" && failureMessage === undefined ? (listing?.listing.directories ?? []) : [];
  const message =
    path === ""
      ? undefined
      : failureMessage !== undefined
        ? { text: failureMessage, error: true }
        : listing !== undefined && listing.listing.truncated
          ? { text: "Some directories are omitted." }
          : listing !== undefined && directories.length === 0
            ? { text: "No directories found." }
            : undefined;

  async function submit() {
    if (!path.trim() || submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      await onAdd(path);
      if (alive.current) close();
    } catch (error) {
      if (alive.current)
        toast.add({
          id: "add-project-error",
          title: "Could not add project",
          description: describeError(error),
          type: "error",
        });
    } finally {
      submitting.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <PathPicker
      value={path}
      onChange={(next, source) => {
        immediate.current = source === "picker";
        // A folder just picked shows its cached children in the same frame; the fetch below then
        // refreshes them.
        const cached = listingCache.get(next);
        if (cached !== undefined) setListing({ path: next, listing: cached });
        // An emptied field starts over: the previous error must not reappear on the next character.
        if (next === "") setFailure(undefined);
        setPath(next);
      }}
      paths={directories}
      onSubmit={() => {
        void submit();
      }}
      onClose={close}
      pending={pending}
      message={message}
    />
  );
}
