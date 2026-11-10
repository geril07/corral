import { AGENT_LAUNCH_CAPABILITY } from "@corral/protocol/config";
import type { ConfigProblem, LaunchProfile } from "@corral/protocol/config";
import type { AgentKind } from "@corral/protocol/rpc";
import { useState } from "react";
import { Button } from "../../common/ui/index.ts";
import {
  SettingsCard,
  SettingsNote,
  SettingsProblems,
  SettingsRow,
} from "./settings-primitives.tsx";

/** What a launch may ask this agent for; the same table the server validates with. */
function capabilityText(kind: AgentKind): string {
  const capability = AGENT_LAUNCH_CAPABILITY[kind];
  if (!capability.model && !capability.provider) return "environment only";
  if (capability.providerRequiresModel) return "model and provider (model required)";
  if (capability.model && capability.provider) return "model and native provider";
  if (capability.model) return kind === "claude" ? "model; gateway via env" : "model only";
  return "provider only";
}

export function ProfileList({
  profiles,
  problems,
}: {
  profiles: readonly LaunchProfile[];
  problems: readonly ConfigProblem[];
}) {
  const profileProblems = problems.filter(
    (problem) => problem.path === "profiles" || problem.path.startsWith("profiles."),
  );
  return (
    <>
      {profiles.length === 0 ? (
        <SettingsNote>
          No profiles. Add a <span className="font-mono text-xs">[profiles.&lt;id&gt;]</span> table
          to the config file
        </SettingsNote>
      ) : (
        <SettingsCard>
          {profiles.map((profile) => (
            <ProfileRow key={`${profile.id}:${profile.revision}`} profile={profile} />
          ))}
        </SettingsCard>
      )}
      <SettingsProblems problems={profileProblems} title="Profile problems" />
    </>
  );
}

function ProfileRow({ profile }: { profile: LaunchProfile }) {
  const [envOpen, setEnvOpen] = useState(false);
  return (
    <SettingsRow
      id={`settings-profile-${profile.id}`}
      title={profile.name}
      description={[
        profile.id,
        profile.agent,
        capabilityText(profile.agent),
        `model ${profile.model ?? "agent default"}`,
        ...(profile.provider ? [`provider ${profile.provider}`] : []),
      ].join(" · ")}
      control={
        profile.env.length > 0 ? (
          <Button
            variant="link"
            aria-expanded={envOpen}
            aria-label={`environment references for ${profile.name}`}
            onClick={() => setEnvOpen((open) => !open)}
          >
            env ({profile.env.length})
          </Button>
        ) : undefined
      }
    >
      {envOpen && (
        <ul className="m-0 mt-1 list-none space-y-1 p-0 text-xs text-muted-foreground">
          {profile.env.map((ref) => (
            <li key={ref.targetName}>
              <span className="font-mono text-xs">{ref.targetName}</span> from server variable{" "}
              <span className="font-mono text-xs">{ref.fromEnv}</span>
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}
