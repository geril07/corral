import { AgentKind, type AgentSetting } from "@corral/protocol/config";
import { Badge } from "../../common/ui/index.ts";
import { useConfig } from "../keymap/index.ts";
import {
  SettingsCard,
  SettingsNote,
  SettingsProblems,
  SettingsRow,
} from "./settings-primitives.tsx";

/**
 * `[agents.<kind>]` and what the host has (`layout.md`, **Board and settings**: an Agents section).
 * Settings is read-only: it names each agent, whether the file offers it, the executable a launch
 * would run, whether the server found it, and whether this build can show it as chat. The chat
 * driver column is the same fact `chat.capabilities` reports.
 */
export function AgentsSection() {
  const { loaded, config, agents, problems } = useConfig();
  if (!loaded) return <SettingsNote>waiting for the server's config…</SettingsNote>;
  return (
    <>
      <SettingsCard>
        {AgentKind.options.map((kind) => {
          const setting = config.agents[kind];
          const availability = agents.find((candidate) => candidate.kind === kind);
          return (
            <SettingsRow
              key={kind}
              id={`settings-agent-${kind}`}
              title={kind}
              description={[
                setting.command.value,
                `${setting.command.source} command`,
                availability === undefined
                  ? "host unknown"
                  : availability.found
                    ? "found"
                    : "not found",
                availability === undefined
                  ? "chat unknown"
                  : availability.chatDriver
                    ? "chat driver"
                    : "terminal only",
              ].join(" · ")}
              control={<EnabledBadge setting={setting} />}
            />
          );
        })}
      </SettingsCard>
      <SettingsProblems
        problems={problems.filter((problem) => problem.path.startsWith("agents"))}
        title="Agent problems"
      />
      <SettingsNote>
        A disabled agent is not offered in any picker and a new launch of it is refused; an existing
        session can still be resumed. <span className="font-mono text-xs">command</span> is an
        absolute path that replaces the <span className="font-mono text-xs">PATH</span> lookup for
        sessions and naming runs. Model, provider and environment stay in launch profiles
      </SettingsNote>
    </>
  );
}

function EnabledBadge({ setting }: { setting: AgentSetting }) {
  return setting.enabled.value ? (
    <Badge variant="secondary">enabled · {setting.enabled.source}</Badge>
  ) : (
    <Badge variant="destructive">disabled · {setting.enabled.source}</Badge>
  );
}
