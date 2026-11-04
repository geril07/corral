import type { Session } from "@corral/protocol/rpc";
import { AGENT_LOGOS } from "./agent-logos.ts";
import { Icon, type IconSize } from "./icon.tsx";

const SIZES = { default: "size-4", row: "size-3", chrome: "size-3.5" } as const;
export function AgentIcon({ kind, size = "default" }: { kind: Session["kind"]; size?: IconSize }) {
  if (kind === "shell") return <Icon name="terminal" size={size} />;
  const logo = AGENT_LOGOS[kind];
  return (
    <svg
      aria-hidden
      viewBox={logo.viewBox}
      className={`shrink-0 ${SIZES[size]}`}
      fill={kind === "claude" ? "#d97757" : "currentColor"}
    >
      {"d" in logo ? (
        <path d={logo.d} fillRule={"fillRule" in logo ? logo.fillRule : undefined} />
      ) : (
        logo.paths.map((d) => <path key={d} d={d} />)
      )}
    </svg>
  );
}
