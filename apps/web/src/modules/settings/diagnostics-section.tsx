import { useEffect, useRef, useState } from "react";
import { Button } from "../../common/ui/index.ts";
import { useConfig } from "../keymap/index.ts";
import { SettingsCard, SettingsProblems, SettingsRow } from "./settings-primitives.tsx";

/** The server-owned file, its problems, and the fact that this background never writes it. */
export function DiagnosticsSection() {
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

  const existence = !loaded
    ? "waiting for the server's config…"
    : exists === false
      ? "not created · Corral applies the built-in defaults"
      : exists === undefined
        ? "unknown · this server does not report whether the file exists"
        : problems.length === 0
          ? "present · no problems"
          : "present";
  const empty = !loaded
    ? {
        title: "Waiting for the server's config",
        description: "Problems appear after the first state",
      }
    : exists === false
      ? {
          title: "The config file has not been created yet",
          description: "Corral applies the built-in defaults",
        }
      : exists === undefined
        ? {
            title: "Existence unknown",
            description: "This server does not report whether the config file exists",
          }
        : { title: "No problems", description: "Every entry in the file is valid" };
  return (
    <>
      <SettingsCard>
        <SettingsRow
          id="settings-diagnostics-path"
          title="Config file"
          description="Corral reads this file and never writes it; edit it with your editor and valid entries apply as you save"
          control={
            loaded &&
            path !== "" && (
              <Button
                variant="outline"
                aria-label="Copy config path"
                onClick={() => void copyPath()}
              >
                Copy path
              </Button>
            )
          }
        >
          <code
            className="settings-path"
            tabIndex={loaded && path !== "" && copy?.kind === "failed" ? 0 : undefined}
            aria-label={loaded && path !== "" ? "Config file path" : undefined}
          >
            {loaded ? path : "waiting for the server's config…"}
          </code>
          {copy?.kind === "copied" && (
            <p key={copy.nonce} className="settings-note" role="status">
              Path copied
            </p>
          )}
          {copy?.kind === "failed" && (
            <p key={copy.nonce} className="settings-note text-destructive" role="alert">
              Copy is unavailable; select the path above
            </p>
          )}
        </SettingsRow>
        <SettingsRow title="State" value={existence} />
      </SettingsCard>
      <SettingsProblems
        id="settings-diagnostics-problems"
        problems={problems}
        title={problems.length > 0 ? `Problems (${problems.length})` : "Problems"}
        empty={empty}
      />
    </>
  );
}
