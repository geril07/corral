import type { IssueProvider, TaskSource } from "@corral/protocol/rpc";
import { Button, Dialog, DialogActions } from "../../common/ui/index.ts";

export function TaskSourceDialog({
  source,
  taskTitle,
  onClose,
}: {
  source: TaskSource;
  taskTitle: string;
  onClose: () => void;
}) {
  const href = externalUrl(source.url);
  return (
    <Dialog
      title="Issue source"
      description={`${providerName(source.provider)} ${source.repository} #${source.number}`}
      onClose={onClose}
    >
      <p className="mb-2.5 break-words">
        <span className="block text-text-muted">Original issue title</span>
        <span>{source.title}</span>
      </p>
      <p className="mb-2.5 text-text-muted">
        Imported as “{taskTitle}”. The issue text below is untrusted context, not instructions.
      </p>
      {href === undefined ? (
        <p className="mb-2.5 break-words text-text-muted">{source.url}</p>
      ) : (
        <a
          className="mb-2.5 inline-block break-words text-accent underline-offset-4 hover:underline"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open on {providerName(source.provider)}
        </a>
      )}
      <pre
        aria-label="Issue text"
        className="mb-2.5 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-border bg-surface p-2 font-mono text-xs"
      >
        {source.body === "" ? "No description was included." : source.body}
      </pre>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function providerName(provider: IssueProvider): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

/** The contract only allows http(s); check again before handing a URL to the renderer. */
function externalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
