import { useEffect, useRef, useState } from "react";
import { Button } from "../../common/ui/index.ts";
import { ConfigProblemsList, useConfig } from "../keymap/index.ts";

/** The server-owned file, its problems, and the fact that this background never writes it. */
export function ConfigFileSection() {
  const { loaded, path, exists, problems } = useConfig();
  const [copy, setCopy] = useState<{ kind: "copied" | "failed"; nonce: number } | undefined>(
    undefined,
  );

  const nonce = useRef(0);
  // Only the confirmation expires; a refusal is a fact the user must be able to act on.
  useEffect(() => {
    if (copy?.kind !== "copied") return undefined;
    const timer = window.setTimeout(() => setCopy(undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [copy]);
  const copyPath = async () => {
    nonce.current += 1;
    try {
      await navigator.clipboard.writeText(path);
      setCopy({ kind: "copied", nonce: nonce.current });
    } catch {
      setCopy({ kind: "failed", nonce: nonce.current });
    }
  };

  return (
    <>
      <p className="mt-0 mb-2 text-muted-foreground">
        Corral reads this file and never writes it. Edit it with your editor; valid entries apply as
        you save.
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <code
          className="min-w-0 break-all font-mono text-xs"
          tabIndex={loaded && path !== "" && copy?.kind === "failed" ? 0 : undefined}
          aria-label={loaded && path !== "" ? "Config file path" : undefined}
        >
          {loaded ? path : "waiting for the server's config…"}
        </code>
        {loaded && path !== "" && (
          <Button variant="outline" aria-label="Copy config path" onClick={() => void copyPath()}>
            Copy path
          </Button>
        )}
      </div>
      {copy?.kind === "copied" && (
        <p key={copy.nonce} className="m-0 mb-2 text-muted-foreground" role="status">
          Path copied.
        </p>
      )}
      {copy?.kind === "failed" && (
        <p key={copy.nonce} className="m-0 mb-2 text-destructive" role="alert">
          Copy is unavailable; select the path above.
        </p>
      )}
      {loaded &&
        (problems.length > 0 ? (
          <>
            <h3 className="mb-1 text-sm">Problems ({problems.length})</h3>
            <ConfigProblemsList problems={problems} />
          </>
        ) : exists === false ? (
          <p className="m-0 text-muted-foreground">
            The config file has not been created yet. Corral applies the built-in defaults.
          </p>
        ) : exists === undefined ? (
          <p className="m-0 text-muted-foreground">
            This server does not report whether the config file exists.
          </p>
        ) : (
          <p className="m-0 text-muted-foreground">No problems.</p>
        ))}
    </>
  );
}
