import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "../lib/cn.ts";
import { Icon, type IconName } from "./icon.tsx";

/** The one cold hover delay for shell and hint tooltips, enabled or aria-disabled alike. */
export const TOOLTIP_DELAY = 300;
/** One close linger, so crossing a trigger does not flicker. */
export const TOOLTIP_CLOSE_DELAY = 100;
/** How long a nearby task tooltip may open at once after the previous one closed. */
export const TOOLTIP_WARM_WINDOW = 300;

export interface TooltipShortcut {
  prefix: string;
  binding: string | null;
}

function TooltipProvider({
  delay = TOOLTIP_DELAY,
  closeDelay = TOOLTIP_CLOSE_DELAY,
  timeout = TOOLTIP_WARM_WINDOW,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      closeDelay={closeDelay}
      timeout={timeout}
      {...props}
    />
  );
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  delay = TOOLTIP_DELAY,
  closeDelay = TOOLTIP_CLOSE_DELAY,
  ...props
}: TooltipPrimitive.Trigger.Props) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      delay={delay}
      closeDelay={closeDelay}
      {...props}
    />
  );
}

export type TooltipVariant = "compact" | "explanation" | "metadata";

const VARIANT_CLASS: Record<TooltipVariant, string> = {
  compact: "visual-tooltip",
  explanation: "visual-tooltip visual-tooltip-explanation",
  metadata: "visual-metadata-tooltip",
};

function TooltipContent({
  variant = "compact",
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  collisionPadding = 8,
  role = "tooltip",
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  variant?: TooltipVariant | undefined;
} & Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "collisionPadding"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          data-variant={variant}
          role={role}
          className={cn("visual-tooltip-surface", VARIANT_CLASS[variant], className)}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

function TooltipKeycaps({ shortcut }: { shortcut: TooltipShortcut }) {
  return (
    <span className="visual-keycaps" aria-hidden="true">
      <kbd className="visual-keycap">{shortcut.prefix}</kbd>
      {shortcut.binding !== null && <kbd className="visual-keycap">{shortcut.binding}</kbd>}
    </span>
  );
}

function TooltipCompact({
  label,
  shortcut,
}: {
  label: string;
  shortcut?: TooltipShortcut | undefined;
}) {
  return (
    <>
      <span className="visual-tooltip-label">{label}</span>
      {shortcut !== undefined && <TooltipKeycaps shortcut={shortcut} />}
    </>
  );
}

function TooltipExplanation({
  label,
  reason,
  shortcut,
}: {
  label: string;
  reason: string;
  shortcut?: TooltipShortcut | undefined;
}) {
  return (
    <>
      <span className="visual-tooltip-heading">
        <span className="visual-tooltip-label">{label}</span>
        {shortcut !== undefined && <TooltipKeycaps shortcut={shortcut} />}
      </span>
      <span className="visual-tooltip-reason">{reason}</span>
    </>
  );
}

export interface TooltipMetadataFact {
  icon: IconName;
  value: string;
  tone?: "error" | undefined;
  /** A single-line identifier; branch paths and prose keep wrapping. */
  truncate?: boolean | undefined;
}

function TooltipMetadata({
  title,
  facts,
}: {
  title: string;
  facts: readonly TooltipMetadataFact[];
}) {
  return (
    <>
      <span className="visual-metadata-title">{title}</span>
      <div className="visual-metadata-facts">
        {facts.map((fact) => (
          <div
            className="visual-metadata-fact"
            data-tone={fact.tone}
            key={`${fact.icon}-${fact.value}`}
          >
            <Icon name={fact.icon} size="row" />
            <span
              className={cn(
                "visual-metadata-value",
                fact.truncate === true && "visual-metadata-truncate",
              )}
            >
              {fact.value}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export {
  Tooltip,
  TooltipCompact,
  TooltipContent,
  TooltipExplanation,
  TooltipKeycaps,
  TooltipMetadata,
  TooltipProvider,
  TooltipTrigger,
};
