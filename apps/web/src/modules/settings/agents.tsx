import { AgentKind, type AgentSetting } from "@corral/protocol/config";
import { Badge } from "../../common/ui/index.ts";
import { useConfig } from "../keymap/index.ts";

/**
 * `[agents.<kind>]` and what the host has (`layout.md`, **Board and settings**: an Agents section).
 * Settings is read-only: it names each agent, whether the file offers it, the executable a launch
 * would run, whether the server found it, and whether this build can show it as chat. The chat
 * driver column is the same fact `chat.capabilities` reports.
 */
export function AgentsSection() {
  const { loaded, config, agents } = useConfig();
  if (!loaded) return <p className="m-0 text-muted-foreground">waiting for the server's config…</p>;
  return (
    <>
      <ul className="m-0 list-none p-0">
        {AgentKind.options.map((kind) => {
          const setting = config.agents[kind];
          const availability = agents.find((candidate) => candidate.kind === kind);
          return (
            <li key={kind} className="flex flex-wrap items-baseline gap-2 py-0.5">
              <span className="w-20 font-mono text-xs">{kind}</span>
              <span className="min-w-0 break-all font-mono text-xs">{setting.command.value}</span>
              <Badge variant="outline">{setting.command.source}</Badge>
              <FoundText found={availability?.found} />
              <span className="ml-auto flex items-center gap-1">
                <span className="text-muted-foreground">chat</span>
                <span>
                  {availability === undefined
                    ? "unknown"
                    : availability.chatDriver
                      ? "driver"
                      : "terminal only"}
                </span>
                <EnabledBadge setting={setting} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 mb-0 text-muted-foreground">
        A disabled agent is not offered in any picker and a new launch of it is refused; an existing
        session can still be resumed. <span className="font-mono text-xs">command</span> is an
        absolute path that replaces the <span className="font-mono text-xs">PATH</span> lookup for
        sessions and naming runs. Model, provider and environment stay in launch profiles.
      </p>
    </>
  );
}

/** Whether the server found the command; an older daemon sends no list, so it is unknown. */
function FoundText({ found }: { found: boolean | undefined }) {
  if (found === undefined) return <span className="text-muted-foreground">unknown</span>;
  return (
    <span className={found ? undefined : "text-destructive"}>{found ? "found" : "not found"}</span>
  );
}

function EnabledBadge({ setting }: { setting: AgentSetting }) {
  return setting.enabled.value ? (
    <Badge variant="secondary">enabled · {setting.enabled.source}</Badge>
  ) : (
    <Badge variant="destructive">disabled · {setting.enabled.source}</Badge>
  );
}
