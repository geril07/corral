import { useState } from "react";
import { Button } from "../../common/ui/index.ts";
import { ConfigProblemsList, useConfig } from "../keymap/index.ts";

/** The server-owned file, its problems, and the fact that this background never writes it. */
export function ConfigFileSection() {
  const { loaded, path, problems } = useConfig();
  const [copy, setCopy] = useState<"copied" | "failed" | undefined>(undefined);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <>
      <p className="mt-0 mb-2 text-muted-foreground">
        Corral reads this file and never writes it. Edit it with your editor; valid entries apply as
        you save.
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all font-mono text-xs">
          {loaded ? path : "waiting for the server's config…"}
        </code>
        {loaded && path !== "" && (
          <Button variant="outline" aria-label="Copy config path" onClick={() => void copyPath()}>
            Copy path
          </Button>
        )}
      </div>
      {copy === "copied" && (
        <p className="m-0 mb-2 text-muted-foreground" role="status">
          Path copied.
        </p>
      )}
      {copy === "failed" && (
        <p className="m-0 mb-2 text-destructive" role="alert">
          Copy is unavailable; select the path above.
        </p>
      )}
      <h3 className="mb-1 text-sm">
        {problems.length === 0 ? "Problems" : `Problems (${problems.length})`}
      </h3>
      {problems.length === 0 ? (
        <p className="m-0 text-muted-foreground">No problems.</p>
      ) : (
        <ConfigProblemsList problems={problems} />
      )}
    </>
  );
}
