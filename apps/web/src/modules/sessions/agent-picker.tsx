import { AGENTS } from "@corral/client/session-state";
import type { AgentKind } from "@corral/protocol/rpc";
import { useState } from "react";
import { Dialog, Kbd, RadioGroup, RadioGroupItem } from "../../common/ui/index.ts";

interface AgentPickerProps {
  onPick: (kind: AgentKind) => void;
  onClose: () => void;
}

const AGENT_ROW =
  "flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-active has-data-checked:bg-surface-active";

/** Digits pick an agent straight away; arrows move, Enter picks the highlighted one. */
export function AgentPicker({ onPick, onClose }: AgentPickerProps) {
  const [highlighted, setHighlighted] = useState<AgentKind>(AGENTS[0] ?? "claude");

  return (
    <Dialog title="New agent session" onClose={onClose}>
      <RadioGroup
        className="mb-1"
        aria-label="agent"
        value={highlighted}
        onValueChange={(kind) => setHighlighted(kind)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onPick(highlighted);
            return;
          }
          const picked = AGENTS[Number(event.key) - 1];
          if (picked && /^[1-9]$/.test(event.key)) {
            event.preventDefault();
            onPick(picked);
          }
        }}
      >
        {AGENTS.map((kind, index) => (
          <label key={kind} className={AGENT_ROW}>
            <RadioGroupItem value={kind} />
            <Kbd aria-hidden>{index + 1}</Kbd>
            {kind}
          </label>
        ))}
      </RadioGroup>
    </Dialog>
  );
}
