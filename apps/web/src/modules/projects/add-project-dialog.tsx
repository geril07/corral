import { describeError } from "@corral/client/rpc-errors";
import { useEffect, useRef, useState } from "react";
import {
  TaskDialog,
  PathPicker,
  PickerToastProvider,
  usePickerToast,
} from "../../common/ui/index.ts";

interface DirectoryListing {
  directories: { name: string; path: string }[];
  truncated: boolean;
}

interface AddProjectDialogProps {
  onAdd: (path: string) => Promise<void>;
  onBrowse: (path: string, signal: AbortSignal) => Promise<DirectoryListing>;
  onClose: () => void;
}

export function AddProjectDialog(props: AddProjectDialogProps) {
  return (
    <PickerToastProvider>
      <ProjectPicker {...props} />
    </PickerToastProvider>
  );
}

function ProjectPicker({ onAdd, onBrowse, onClose }: AddProjectDialogProps) {
  const [path, setPath] = useState("~/");
  const [result, setResult] = useState<{
    path: string;
    listing?: DirectoryListing;
    failure?: string;
  }>();
  const listing = !path
    ? { directories: [], truncated: false }
    : result?.path === path
      ? result.listing
      : undefined;
  const failure = result?.path === path ? result.failure : undefined;
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const alive = useRef(true);
  const toast = usePickerToast();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (path)
      void onBrowse(path, controller.signal).then(
        (response) => {
          if (!controller.signal.aborted) setResult({ path, listing: response });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setResult({ path, failure: describeError(error) });
        },
      );
    return () => controller.abort();
  }, [path, onBrowse]);

  async function submit() {
    if (!path.trim() || submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      await onAdd(path);
      if (alive.current) onClose();
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
    <TaskDialog title="Add project" layout="path-picker" showCloseButton={false} onClose={onClose}>
      <PathPicker
        value={path}
        onChange={setPath}
        paths={listing?.directories ?? []}
        onSubmit={() => {
          void submit();
        }}
        onClose={onClose}
        pending={pending}
        status={
          pending
            ? "Adding project…"
            : (failure ??
              (listing === undefined
                ? "Loading directories…"
                : listing.truncated
                  ? "Some directories are omitted. Type a longer path to narrow the list."
                  : listing.directories.length === 0
                    ? "No directories found."
                    : undefined))
        }
      />
    </TaskDialog>
  );
}
