import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/** A labelled control. The label wraps the control, so its text is the control's accessible name. */
export function Field({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("mb-2.5 flex flex-col gap-1 text-text-muted", className)}>
      {label}
      {children}
    </label>
  );
}
