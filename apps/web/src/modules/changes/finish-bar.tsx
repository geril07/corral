import { describeError, procedureMissing } from "@corral/client/rpc-errors";
import type { ChangesFinish, IssueProvider, PullRequest, Task } from "@corral/protocol/rpc";
import { useEffect, useMemo, useRef, useState } from "react";
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

export interface FinishBarProps {
  task: Task;
  actions: ChangesActions;
  /** The file the diff pane shows, so "stage this file" works on the selection. */
  selectedPath: string | undefined;
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
  pullRequest,
  onPullRequest,
  onSettle,
}: FinishBarProps) {
  const [finish, setFinish] = useState<ChangesFinish>();
  const [loadError, setLoadError] = useState<unknown>();
  const [failure, setFailure] = useState<unknown>();
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<"push" | "create">();
  const [pending, setPending] = useState(false);
  // The guard a double click needs: state updates are not synchronous, a ref is.
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    actions.finish().then(
      (next) => {
        if (live) {
          setFinish(next);
          setLoadError(undefined);
        }
      },
      (error: unknown) => {
        if (live) setLoadError(error);
      },
    );
    return () => {
      live = false;
    };
  }, [actions]);

  const run = async (work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await work();
      setFailure(undefined);
    } catch (error) {
      // The message field and the list selection are deliberately left as they were.
      setFailure(error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const staged = finish?.staged ?? [];
  const selectedStaged = selectedPath !== undefined && staged.includes(selectedPath);
  const branch = finish?.branch ?? null;
  const base = finish?.base ?? null;
  const remote = finish?.remote ?? null;
  const canPush = branch !== null && remote !== null && finish !== undefined;

  const stage = (paths: string[] | "all", stagedNow: boolean) =>
    run(async () => {
      setFinish(await actions.stage({ paths, staged: stagedNow }));
    });

  const commit = () =>
    run(async () => {
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

  const openCreate = () => {
    setProvider(prProvider);
    setTitle(prTitle);
    setBody(prBody);
    setDraft(false);
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
          disabled={pending}
          onClick={() => void stage("all", true)}
        >
          Stage all
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || staged.length === 0}
          onClick={() => void stage("all", false)}
        >
          Unstage all
        </Button>
        {selectedPath !== undefined && (
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => void stage([selectedPath], !selectedStaged)}
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
          disabled={pending || message.trim() === "" || staged.length === 0}
          onClick={() => void commit()}
        >
          Commit
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={pending || !canPush}
          title={
            branch === null
              ? "This task has no branch checked out."
              : remote === null
                ? "No remote would take this branch."
                : `Push ${branch} to ${remote.url}`
          }
          onClick={() => setDialog("push")}
        >
          Push…
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={pending || !canPush || base === null}
          title={
            remote === null
              ? "No remote would take this branch."
              : `Open a request from ${branch ?? "the branch"} into ${base ?? "the base branch"}`
          }
          onClick={openCreate}
        >
          Create pull request…
        </Button>
        {pullRequest !== undefined && <PullRequestBadge request={pullRequest} />}
        {pullRequest?.state === "merged" && task.state === "active" && (
          <Button size="xs" variant="secondary" onClick={onSettle}>
            Settle task
          </Button>
        )}
      </div>
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
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const pushed = await actions.push({ remote, branch });
                  setFinish(pushed.finish);
                  setDialog(undefined);
                })
              }
            >
              Push {branch}
            </Button>
          </DialogActions>
        </TaskDialog>
      )}
      {dialog === "create" && branch !== null && remote !== null && base !== null && (
        <CreatePullRequestDialog
          provider={provider}
          branch={branch}
          base={base}
          remoteUrl={remote.url}
          remoteName={remote.name}
          title={title}
          body={body}
          draft={draft}
          pending={pending}
          failure={failure}
          onChangeProvider={setProvider}
          onChangeTitle={setTitle}
          onChangeBody={setBody}
          onToggleDraft={setDraft}
          onClose={() => setDialog(undefined)}
          onCreate={() =>
            void run(async () => {
              const created = await actions.createPullRequest({
                provider,
                remote,
                branch,
                base,
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
  pending: boolean;
  failure: unknown;
  onChangeProvider: (value: IssueProvider) => void;
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
        <Button disabled={pending || title.trim() === ""} onClick={onCreate}>
          Create in {base}
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
