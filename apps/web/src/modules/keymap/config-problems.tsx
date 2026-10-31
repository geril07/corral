import type { ConfigProblem } from "@corral/protocol/config";
import { TaskDialog, IconButton } from "../../common/ui/index.ts";
import { useConfig } from "./config-context.tsx";

/** The non-blocking hint in the sidebar footer; nothing when the file has no problems. */
export function ConfigProblemsNotice({ onOpen }: { onOpen: (opener?: HTMLElement) => void }) {
  const { problems } = useConfig();
  if (problems.length === 0) return null;
  const count = `${problems.length} ${problems.length === 1 ? "problem" : "problems"}`;
  return (
    <IconButton
      label={`config: ${count}`}
      tooltip={`Config problems · ${count}`}
      icon="warn"
      variant="destructive"
      onClick={(event) => onOpen(event.currentTarget)}
    />
  );
}

/** Each rejected entry with the file it came from; the rest of the file still applies. */
export function ConfigProblemsDialog({ onClose }: { onClose: () => void }) {
  const { path, problems } = useConfig();
  return (
    <TaskDialog
      title="Config problems"
      description="The valid entries still apply; fix the file and save."
      onClose={onClose}
    >
      <p className="mb-3 break-all font-mono text-xs text-muted-foreground">{path}</p>
      <ConfigProblemsList problems={problems} />
    </TaskDialog>
  );
}

/** Each rejected entry; the settings background and the dialog show the same rows. */
export function ConfigProblemsList({ problems }: { problems: readonly ConfigProblem[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {problems.map((problem) => (
        <ProblemRow
          key={`${problem.severity}:${problem.path}:${problem.message}`}
          problem={problem}
        />
      ))}
    </ul>
  );
}

function ProblemRow({ problem }: { problem: ConfigProblem }) {
  return (
    <li>
      <div className="flex items-baseline gap-2">
        <span
          className={problem.severity === "error" ? "text-destructive" : "text-muted-foreground"}
        >
          {problem.severity}
        </span>
        <span className="break-all font-mono text-xs text-muted-foreground">
          {problem.path || "(whole file)"}
        </span>
      </div>
      <p className="mt-0.5 break-words">{problem.message}</p>
    </li>
  );
}
