import type { ConfigProblem } from "@corral/protocol/config";
import { Button, Dialog } from "../../common/ui/index.ts";
import { useConfig } from "./config-context.tsx";

/** The non-blocking hint in the sidebar footer; nothing when the file has no problems. */
export function ConfigProblemsNotice({ onOpen }: { onOpen: () => void }) {
  const { problems } = useConfig();
  if (problems.length === 0) return null;
  return (
    <Button variant="link" size="sm" className="my-0.5 text-danger" onClick={onOpen}>
      config: {problems.length} {problems.length === 1 ? "problem" : "problems"}
    </Button>
  );
}

/** Each rejected entry with the file it came from; the rest of the file still applies. */
export function ConfigProblemsDialog({ onClose }: { onClose: () => void }) {
  const { path, problems } = useConfig();
  return (
    <Dialog
      title="Config problems"
      description="The valid entries still apply; fix the file and save."
      onClose={onClose}
    >
      <p className="mb-3 break-all font-mono text-xs text-text-muted">{path}</p>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {problems.map((problem) => (
          <ProblemRow
            key={`${problem.severity}:${problem.path}:${problem.message}`}
            problem={problem}
          />
        ))}
      </ul>
    </Dialog>
  );
}

function ProblemRow({ problem }: { problem: ConfigProblem }) {
  return (
    <li>
      <div className="flex items-baseline gap-2">
        <span className={problem.severity === "error" ? "text-danger" : "text-status-blocked"}>
          {problem.severity}
        </span>
        <span className="break-all font-mono text-xs text-text-muted">
          {problem.path || "(whole file)"}
        </span>
      </div>
      <p className="mt-0.5 break-words">{problem.message}</p>
    </li>
  );
}
