import { describeError, procedureMissing } from "@corral/client/rpc-errors";
import type { ChangesFinish, IssueProvider, PullRequest, Task } from "@corral/protocol/rpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  DialogActions,
  FormError,
  FormField,
  Input,
  RadioChoice,
  RadioGroup,
  TaskDialog,
  Textarea,
} from "../../common/ui/index.ts";
import type { ChangesActions } from "./finish-actions.ts";
import { PullRequestBadge, pullRequestChecks, pullRequestTitle } from "./pull-request-badge.tsx";
import { branchDrift } from "../tasks/branch-facts.ts";

export interface FinishBarProps {
  task: Task;
  actions: ChangesActions;
  /** The file the diff pane shows, so "stage this file" works on the selection. */
  selectedPath: string | undefined;
  /** The path before a rename; staging or unstaging the row moves it with `selectedPath`. */
  selectedOldPath: string | null | undefined;
  /** The request linked to this task, when one is. */
  pullRequest: PullRequest | undefined;
  /** A request this bar created or refreshed, for the header and the sidebar. */
  onPullRequest: (request: PullRequest) => void;
  /** Merged requests offer settle; settling stays the user's action (`design.md`, **Domain model**). */
  onSettle: () => void;
}

/**
 * The Changes tab's write controls (`layout.md`, **Changes**: below the summary row): staging, the
 * commit message and commit, then push and create-pull-request behind one confirmation each. Every
 * remote write names the remote URL and the branch it will use, and the server refuses a remote
 * whose URL is no longer the confirmed one. A failed write keeps the selection and the message.
 */
export function FinishBar({
  task,
  actions,
  selectedPath,
  selectedOldPath,
  pullRequest,
  onPullRequest,
  onSettle,
}: FinishBarProps) {
  const [finish, setFinish] = useState<ChangesFinish>();
  const [loadError, setLoadError] = useState<unknown>();
  const [failure, setFailure] = useState<unknown>();
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<"push" | "create">();
  const [pending, setPending] = useState<"stage" | "commit" | "push" | "create" | false>(false);
  // The guard a double click needs: state updates are not synchronous, a ref is.
  const busy = useRef(false);
  /** Re-reads the branch, base, remote and staged paths; `undefined` keeps the last answer. */
  const reload = useCallback(
    () =>
      actions.finish().then(
        (next) => {
          setFinish(next);
          setLoadError(undefined);
          return next;
        },
        (error: unknown) => {
          setLoadError(error);
          return undefined;
        },
      ),
    [actions],
  );

  useEffect(() => {
    void reload();
    // Opening the tab reads once; a branch switched or renamed outside Corral while it stays open
    // is picked up when the window regains focus, the same moment the changes read refreshes.
    const refresh = () => void reload();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [reload]);

  const run = async (what: "stage" | "commit" | "push" | "create", work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(what);
    try {
      await work();
      setFailure(undefined);
    } catch (error) {
      // The message field and the list selection are deliberately left as they were, and the
      // controls re-read their facts: a refusal such as `CHANGES_REMOTE_MISMATCH` tells the user
      // the remote changed, and the retry has to offer the new one.
      setFailure(error);
      await reload();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const staged = finish?.staged ?? [];
  // A rename's old path can be gone after its commit, so only the selected (new) path answers
  // whether the row is staged. Pairing still moves both paths when an uncommitted rename has them.
  const selectedPaths =
    selectedPath === undefined
      ? []
      : selectedOldPath === null ||
          selectedOldPath === undefined ||
          selectedOldPath === selectedPath
        ? [selectedPath]
        : [selectedOldPath, selectedPath];
  const selectedStaged = selectedPath !== undefined && staged.includes(selectedPath);
  const branch = finish?.branch ?? null;
  const base = finish?.base ?? null;
  const remote = finish?.remote ?? null;
  const canPush = branch !== null && remote !== null && finish !== undefined;
  const drift = branchDrift(task.branch, branch);
  /** Why push and create are unavailable, in the user's words; the tooltip names the remotes. */
  const blocked =
    branch === null
      ? "This task has no branch checked out."
      : remote === null
        ? finish === undefined || finish.remotes.length === 0
          ? "This repository has no remote."
          : `No remote would take ${branch}; configured remotes: ${finish.remotes
              .map((each) => each.name)
              .join(", ")}.`
        : undefined;

  const stage = (paths: string[] | "all", stagedNow: boolean) =>
    run("stage", async () => {
      setFinish(await actions.stage({ paths, staged: stagedNow }));
    });

  const commit = () =>
    run("commit", async () => {
      const committed = await actions.commit(message);
      setFinish(committed.finish);
      // Only a successful commit clears the message; a refusal keeps it.
      setMessage("");
    });

  const prTitle = useMemo(() => task.title, [task.title]);
  const prBody = useMemo(() => task.prompt ?? "", [task.prompt]);
  const prProvider = useMemo<IssueProvider>(() => {
    const source = task.source?.provider;
    if (source !== undefined) return source;
    if (remote !== null && /gitlab/i.test(remote.url)) return "gitlab";
    return "github";
  }, [task.source, remote]);
  const [draft, setDraft] = useState(false);
  const [provider, setProvider] = useState<IssueProvider>(prProvider);
  const [title, setTitle] = useState(prTitle);
  const [body, setBody] = useState(prBody);
  /** The base branch is editable: a task is not always merged into the project's default. */
  const [dialogBase, setDialogBase] = useState(base ?? "main");

  const openCreate = () => {
    setProvider(prProvider);
    setTitle(prTitle);
    setBody(prBody);
    setDraft(false);
    setDialogBase(base ?? "main");
    setDialog("create");
  };

  if (loadError !== undefined) {
    return (
      <Notice>
        {procedureMissing(loadError)
          ? "This server does not offer commit, push or pull requests; restart it after upgrading Corral."
          : describeError(loadError)}
      </Notice>
    );
  }
  if (finish === undefined) return null;

  return (
    <div
      className="mb-2 flex shrink-0 flex-col gap-2 border-b border-border pb-2"
      role="group"
      aria-label="Finish"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={pending !== false}
          onClick={() => void stage("all", true)}
        >
          Stage all
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending !== false || staged.length === 0}
          onClick={() => void stage("all", false)}
        >
          Unstage all
        </Button>
        {selectedPath !== undefined && (
          <Button
            size="xs"
            variant="ghost"
            disabled={pending !== false}
            onClick={() => void stage(selectedPaths, !selectedStaged)}
          >
            {selectedStaged ? "Unstage" : "Stage"} {selectedPath}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {staged.length === 0 ? "nothing staged" : `${staged.length} staged`}
        </span>
      </div>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <Textarea
            aria-label="Commit message"
            placeholder="Commit message"
            layout="commit"
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <Button
          size="xs"
          disabled={pending !== false || message.trim() === "" || staged.length === 0}
          onClick={() => void commit()}
        >
          {pending === "commit" ? "Committing…" : "Commit"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={pending !== false || !canPush}
          title={blocked ?? `Push ${branch} to ${remote?.url}`}
          onClick={() => setDialog("push")}
        >
          {pending === "push" ? "Pushing…" : "Push…"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={pending !== false || !canPush || base === null}
          title={blocked ?? `Open a request from ${branch} into ${base}`}
          onClick={openCreate}
        >
          {pending === "create" ? "Creating…" : "Create pull request…"}
        </Button>
        {pullRequest !== undefined && <PullRequestBadge request={pullRequest} />}
        {pullRequest?.state === "merged" && task.state === "active" && (
          <Button size="xs" variant="secondary" onClick={onSettle}>
            Settle task
          </Button>
        )}
      </div>
      {drift !== undefined && (
        <p data-branch-drift className="m-0 text-xs text-muted-foreground">
          {drift}
        </p>
      )}
      {blocked !== undefined && (
        <p data-finish-blocked className="m-0 text-xs text-muted-foreground">
          {blocked}
        </p>
      )}
      {pullRequest !== undefined && pullRequest.checks !== null && (
        <p className="m-0 text-xs text-muted-foreground" title={pullRequestTitle(pullRequest)}>
          {pullRequestChecks(pullRequest)}
        </p>
      )}
      {failure !== undefined && (
        <Alert variant="destructive">
          <AlertDescription role="alert">{describeError(failure)}</AlertDescription>
        </Alert>
      )}
      {dialog === "push" && branch !== null && remote !== null && (
        <TaskDialog
          title={`Push ${branch} to ${remote.name}?`}
          description={`Push branch ${branch} to the remote ${remote.name} at ${remote.url}. No force, no branch deletion, and the upstream is left as it is.`}
          onClose={() => setDialog(undefined)}
        >
          {failure !== undefined && <FormError>{describeError(failure)}</FormError>}
          <DialogActions>
            <Button variant="outline" onClick={() => setDialog(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={pending !== false}
              onClick={() =>
                void run("push", async () => {
                  const pushed = await actions.push({ remote, branch });
                  setFinish(pushed.finish);
                  setDialog(undefined);
                })
              }
            >
              {pending === "push" ? "Pushing…" : `Push ${branch}`}
            </Button>
          </DialogActions>
        </TaskDialog>
      )}
      {dialog === "create" && branch !== null && remote !== null && base !== null && (
        <CreatePullRequestDialog
          provider={provider}
          branch={branch}
          base={dialogBase}
          remoteUrl={remote.url}
          remoteName={remote.name}
          title={title}
          body={body}
          draft={draft}
          pending={pending}
          failure={failure}
          onChangeProvider={setProvider}
          onChangeBase={setDialogBase}
          onChangeTitle={setTitle}
          onChangeBody={setBody}
          onToggleDraft={setDraft}
          onClose={() => setDialog(undefined)}
          onCreate={() =>
            void run("create", async () => {
              const created = await actions.createPullRequest({
                provider,
                remote,
                branch,
                base: dialogBase.trim(),
                title,
                body,
                draft,
              });
              onPullRequest(created);
              setDialog(undefined);
            })
          }
        />
      )}
    </div>
  );
}

/**
 * The second confirmation: it names the request's target (base, head, remote URL) and states that
 * creating does not push, because the push was its own action.
 */
function CreatePullRequestDialog({
  provider,
  branch,
  base,
  remoteName,
  remoteUrl,
  title,
  body,
  draft,
  pending,
  failure,
  onChangeProvider,
  onChangeBase,
  onChangeTitle,
  onChangeBody,
  onToggleDraft,
  onCreate,
  onClose,
}: {
  provider: IssueProvider;
  branch: string;
  base: string;
  remoteName: string;
  remoteUrl: string;
  title: string;
  body: string;
  draft: boolean;
  pending: false | "stage" | "commit" | "push" | "create";
  failure: unknown;
  onChangeProvider: (value: IssueProvider) => void;
  onChangeBase: (value: string) => void;
  onChangeTitle: (value: string) => void;
  onChangeBody: (value: string) => void;
  onToggleDraft: (value: boolean) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <TaskDialog
      title="Create a pull request"
      description={`From ${branch} into ${base}, through ${remoteName} (${remoteUrl}). The branch is already pushed: this opens the request and never pushes.`}
      onClose={onClose}
    >
      {failure !== undefined && <FormError>{describeError(failure)}</FormError>}
      <RadioGroup
        aria-label="Provider"
        value={provider}
        // The provider is the CLI that runs, not something the answer tells: the user picks it.
        onValueChange={(value) => onChangeProvider(value === "gitlab" ? "gitlab" : "github")}
      >
        <RadioChoice value="github">GitHub (gh)</RadioChoice>
        <RadioChoice value="gitlab">GitLab (glab)</RadioChoice>
      </RadioGroup>
      <FormField label="Base branch">
        <Input value={base} onChange={(event) => onChangeBase(event.target.value)} />
      </FormField>
      <FormField label="Title">
        <Input value={title} onChange={(event) => onChangeTitle(event.target.value)} />
      </FormField>
      <FormField label="Description">
        <Textarea rows={4} value={body} onChange={(event) => onChangeBody(event.target.value)} />
      </FormField>
      <Button size="xs" variant="ghost" aria-pressed={draft} onClick={() => onToggleDraft(!draft)}>
        {draft ? "Draft: on" : "Open as a draft"}
      </Button>
      <DialogActions>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={pending !== false || title.trim() === "" || base === ""}
          onClick={onCreate}
        >
          {pending === "create" ? "Creating…" : `Create in ${base}`}
        </Button>
      </DialogActions>
    </TaskDialog>
  );
}

function Notice({ children }: { children: string }) {
  return (
    <p className="m-0 mb-2 shrink-0 text-xs text-muted-foreground" role="status">
      {children}
    </p>
  );
}
