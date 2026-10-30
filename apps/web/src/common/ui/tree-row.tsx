import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/** One row of the sidebar tree; the selected row is marked by its accent bar, not by colour alone. */
export function TreeRow({
  current,
  project,
  className,
  children,
}: {
  current?: boolean;
  project?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center",
        current && "border-l-2 border-accent bg-surface-active",
        !current && "border-l-2 border-transparent",
        className,
      )}
      data-current={current || undefined}
      data-project={project || undefined}
    >
      {children}
    </div>
  );
}

export function TreeIndent({ children }: { children: ReactNode }) {
  return <div className="flex flex-col pl-3">{children}</div>;
}
