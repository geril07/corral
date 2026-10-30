import type { AgentKind } from "@corral/protocol/rpc";
import type { AgentAdapter } from "./agent-adapter.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";

export const AGENTS: Record<AgentKind, AgentAdapter> = { claude, codex, pi, opencode };
