import type { ComponentProps, ReactNode } from "react";
import { Button } from "./button.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { Hint } from "./hint.tsx";

export interface IconButtonProps extends Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children"
> {
  /** The accessible name, and the tooltip's words unless `tooltip` gives more. */
  label: string;
  tooltip?: ReactNode;
  icon: IconName;
}

/** A named stock icon button with an optional hint. */
export function IconButton({
  label,
  tooltip,
  icon,
  size = "icon",
  variant = "ghost",
  ...props
}: IconButtonProps) {
  return (
    <Hint content={tooltip ?? label}>
      <Button aria-label={label} size={size} variant={variant} {...props}>
        <Icon name={icon} />
      </Button>
    </Hint>
  );
}
