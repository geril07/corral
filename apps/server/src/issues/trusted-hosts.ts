import type { IssueProvider } from "@corral/protocol/rpc";
import { git } from "../git/git.ts";
import { publicProviderForHost, type IssueRef } from "./issue-url.ts";

const ENV_HOSTS: Readonly<Record<IssueProvider, readonly string[]>> = {
  github: ["GH_HOST"],
  gitlab: ["GITLAB_HOST", "GITLAB_URI", "GL_HOST"],
};

/** A host from an operator environment variable, with its port when one was given. */
export function envTrustedHosts(
  provider: IssueProvider,
  env: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const name of ENV_HOSTS[provider]) {
    const value = env[name]?.trim();
    if (value === undefined || value === "") continue;
    const host = hostOfValue(value);
    if (host !== undefined) hosts.add(host);
  }
  return hosts;
}

/** The host a git remote points at; SSH transport ports are not web/API ports, so they are dropped. */
export function hostOfRemote(remote: string): string | undefined {
  // Local paths are not remotes. Check Windows drives, UNC paths and file: before scp syntax,
  // or C:\\repo would look like host "c".
  if (/^[a-z]:/i.test(remote) || /^(?:\/\/|\\\\)/.test(remote) || /^file:/i.test(remote))
    return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return undefined;
    }
    if (url.protocol === "http:" || url.protocol === "https:") return url.host.toLowerCase();
    if (url.protocol === "ssh:" || url.protocol === "git:") return url.hostname.toLowerCase();
    return undefined;
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)/.exec(remote);
  return scp?.[1]?.toLowerCase();
}

/** How a custom host earned its trust; public hosts need no binding. */
export interface IssueHostTrust {
  publicHost: boolean;
  /** The operator named this exact host for this provider (GH_HOST/GITLAB_HOST). */
  operatorHost: boolean;
}

/** Public hosts are trusted by definition; self-hosted hosts need a project remote or operator env. */
export async function issueHostTrust(
  projectPath: string,
  ref: IssueRef,
  env: NodeJS.ProcessEnv,
): Promise<IssueHostTrust | undefined> {
  const hostname = new URL(ref.url).hostname;
  if (publicProviderForHost(hostname) === ref.provider)
    return { publicHost: true, operatorHost: false };
  if (envTrustedHosts(ref.provider, env).has(ref.host))
    return { publicHost: false, operatorHost: true };
  let remotes: string;
  try {
    remotes = await git(projectPath, ["remote", "-v"]);
  } catch {
    return undefined;
  }
  const matched = remotes.split("\n").some((line) => {
    const remote = line.split(/\s+/)[1];
    return remote !== undefined && hostOfRemote(remote) === ref.host;
  });
  return matched ? { publicHost: false, operatorHost: false } : undefined;
}

function hostOfValue(value: string): string | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.username !== "" || url.password !== "") return undefined;
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}
