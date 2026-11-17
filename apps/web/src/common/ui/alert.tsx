import * as React from "react";
import { cn } from "../lib/cn.ts";

function Alert({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "destructive";
  /** `compact` is one line of a chrome row: no block padding, the row's own width. */
  size?: "default" | "compact";
}) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      data-size={size}
      role="alert"
      className={cn("visual-alert", className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("visual-alert-title", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn(className)} {...props} />;
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="alert-action" className={cn("visual-alert-action", className)} {...props} />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
