/** Shared launch refusals for retained selections and server errors. */
export function agentDisabled(kind: string): string {
  return `The ${kind} agent is disabled in the config file. Choose another agent.`;
}

export function profileMissing(name: string): string {
  return `The profile "${name}" is no longer in the config file. Choose an agent or another profile.`;
}

export function profileChanged(name: string): string {
  return `The profile "${name}" changed on the server. Review it and choose it again.`;
}

export function launchViewUnsupported(kind: string, view: unknown): string | undefined {
  if (view !== "chat") return undefined;
  return kind === "shell"
    ? "A shell runs in a terminal only."
    : `The ${kind} agent has no chat driver in this build.`;
}
