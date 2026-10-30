import type { ReactNode } from "react";
import { Button, type ButtonProps } from "./button.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { Tooltip } from "./tooltip.tsx";

export interface IconButtonProps extends Omit<ButtonProps, "aria-label" | "children"> {
  /** The accessible name, and the tooltip's words unless `tooltip` gives more. */
  label: string;
  tooltip?: ReactNode;
  icon: IconName;
}

/** A 28px icon-only action: named for assistive technology and explained in a tooltip. */
export function IconButton({
  label,
  tooltip,
  icon,
  size = "icon-sm",
  variant = "ghost-muted",
  ...props
}: IconButtonProps) {
  return (
    <Tooltip content={tooltip ?? label}>
      <Button aria-label={label} size={size} variant={variant} {...props}>
        <Icon name={icon} />
      </Button>
    </Tooltip>
  );
}
