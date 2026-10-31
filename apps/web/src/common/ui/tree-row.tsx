import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/** Structural tree row; its button owns the stock selected appearance and aria-current. */
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
      className={cn("flex items-center", className)}
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
