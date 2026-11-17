import type { ChatContextUsage } from "@corral/protocol/chat";
import { Button, Hint, ProgressRing } from "../../common/ui/index.ts";
import {
  contextDetail,
  contextLabel,
  contextPercentage,
  DANGER_PERCENTAGE,
} from "./chat-context.ts";

/**
 * The context-window ring beside the send button. `type="button"` keeps it out of the composer
 * form's submit: the control is a reading, not an action, and its tooltip carries the numbers the
 * ring cannot show.
 */
export function ChatContextMeter({ usage }: { usage: ChatContextUsage }) {
  const percentage = contextPercentage(usage);
  return (
    <Hint content={contextDetail(usage)}>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={contextLabel(usage)}>
        <ProgressRing
          percentage={percentage}
          tone={percentage !== null && percentage >= DANGER_PERCENTAGE ? "danger" : "muted"}
        />
      </Button>
    </Hint>
  );
}
