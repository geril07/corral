import { expect, test } from "vite-plus/test";
import { adoptDiscoveredAgentSessionId } from "./session-service.ts";

/** The one field the helper reads and writes; the rest of the row is irrelevant here. */
function storeWith(agentSessionId: string | null) {
  const row = { agentSessionId };
  return {
    row,
    store: {
      get: (_id: string) => row,
      setAgentSessionId: (_id: string, value: string | null) => {
        row.agentSessionId = value;
      },
    },
  };
}

test("a discovered rollout id fills an empty row and never overwrites a stored one", () => {
  const empty = storeWith(null);
  expect(adoptDiscoveredAgentSessionId(empty.store, "session-1", "rollout-a")).toBe(true);
  expect(empty.row.agentSessionId).toBe("rollout-a");

  const chat = storeWith("thr-chat");
  expect(adoptDiscoveredAgentSessionId(chat.store, "session-1", "rollout-late")).toBe(false);
  expect(chat.row.agentSessionId).toBe("thr-chat");
});
