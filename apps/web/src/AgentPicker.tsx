import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { AGENTS } from "@corral/client/session-state";
import type { AgentKind } from "@corral/protocol/rpc";
import { useState } from "react";
import { Modal } from "./Modal.tsx";

interface AgentPickerProps {
  onPick: (kind: AgentKind) => void;
  onClose: () => void;
}

/** Digits pick an agent straight away; arrows move, Enter picks the highlighted one. */
export function AgentPicker({ onPick, onClose }: AgentPickerProps) {
  const [highlighted, setHighlighted] = useState<AgentKind>(AGENTS[0] ?? "claude");

  return (
    <Modal title="New agent session" onClose={onClose}>
      <RadioGroup
        className="agents"
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
          <label key={kind} className="agent">
            <Radio.Root value={kind} className="agent-radio" />
            <kbd aria-hidden>{index + 1}</kbd>
            {kind}
          </label>
        ))}
      </RadioGroup>
    </Modal>
  );
}
