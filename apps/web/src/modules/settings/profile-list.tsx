import { AGENT_LAUNCH_CAPABILITY } from "@corral/protocol/config";
import type { AgentKind } from "@corral/protocol/rpc";
import type { LaunchProfile } from "@corral/protocol/config";
import { useState } from "react";
import { Button } from "../../common/ui/index.ts";

/** What a launch may ask this agent for; the same table the server validates with. */
function capabilityText(kind: AgentKind): string {
  const capability = AGENT_LAUNCH_CAPABILITY[kind];
  if (!capability.model && !capability.provider) return "environment only";
  if (capability.providerRequiresModel) return "model and provider (model required)";
  if (capability.model && capability.provider) return "model and native provider";
  if (capability.model) return kind === "claude" ? "model; gateway via env" : "model only";
  return "provider only";
}

export function ProfileList({ profiles }: { profiles: readonly LaunchProfile[] }) {
  if (profiles.length === 0) {
    return (
      <p className="m-0 text-text-muted">
        No profiles. Add a <span className="font-mono text-xs">[profiles.&lt;id&gt;]</span> table to
        the config file.
      </p>
    );
  }
  return (
    <ul className="m-0 list-none p-0">
      {profiles.map((profile) => (
        <ProfileRow key={`${profile.id}:${profile.revision}`} profile={profile} />
      ))}
    </ul>
  );
}

function ProfileRow({ profile }: { profile: LaunchProfile }) {
  const [envOpen, setEnvOpen] = useState(false);
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{profile.name}</span>
        <span className="font-mono text-xs text-text-muted">{profile.id}</span>
        <span className="text-text-muted">
          {profile.agent} · {capabilityText(profile.agent)}
        </span>
        <span className="text-text-muted">model {profile.model ?? "agent default"}</span>
        {profile.provider && <span className="text-text-muted">provider {profile.provider}</span>}
        {profile.env.length > 0 && (
          <Button
            variant="link"
            size="sm"
            aria-expanded={envOpen}
            aria-label={`environment references for ${profile.name}`}
            onClick={() => setEnvOpen((open) => !open)}
          >
            env ({profile.env.length})
          </Button>
        )}
      </div>
      {envOpen && (
        <ul className="m-0 mt-0.5 list-none p-0 pl-3 text-text-muted">
          {profile.env.map((ref) => (
            <li key={ref.targetName}>
              <span className="font-mono text-xs">{ref.targetName}</span> from server variable{" "}
              <span className="font-mono text-xs">{ref.fromEnv}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
