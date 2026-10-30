import { commands } from "vite-plus/test/browser";

export interface AgentLaunch {
  agent: string;
  argv: string[];
  cwd: string;
  env: { CORRAL_SESSION_ID?: string; CORRAL_TASK_ID?: string };
}

// Custom commands are not part of the library's types, which this package cannot augment.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const custom = commands as unknown as {
  agentLaunches: () => Promise<AgentLaunch[]>;
  serverEnv: (name: string, value: string | null) => Promise<string | null>;
};

/** Every launch of a fake agent by the test server so far, oldest first (see `server-agents.ts`). */
export const agentLaunches = () => custom.agentLaunches();

/**
 * Sets (or, with `null`, unsets) an environment variable of the test server, which reads it when
 * it starts a session. Returns the value it had before.
 */
export const setServerEnv = (name: string, value: string | null) => custom.serverEnv(name, value);
