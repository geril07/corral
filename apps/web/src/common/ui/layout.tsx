import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Two-pane application: a fixed sidebar and the screen that takes the rest. `sidebarWidth`
 * overrides the stock 16 rem column, including 0 for a hidden sidebar (`layout.md`, **Shell**).
 */
export function AppShell({
  children,
  sidebarWidth,
  className,
}: {
  children: ReactNode;
  sidebarWidth?: number;
  className?: string;
}) {
  const style: CSSProperties | undefined =
    sidebarWidth === undefined
      ? undefined
      : {
          // A hidden sidebar leaves a single column: a 0 px track would hold the main area.
          gridTemplateColumns:
            sidebarWidth === 0 ? "minmax(0, 1fr)" : `${sidebarWidth}px minmax(0, 1fr)`,
        };
  return (
    <div className={cn("grid h-screen grid-cols-[16rem_minmax(0,1fr)]", className)} style={style}>
      {children}
    </div>
  );
}

export function SidebarPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <aside
      className={cn(
        "relative flex min-h-0 flex-col justify-between border-r border-border bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      {children}
    </aside>
  );
}

export function MainPanel({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn("relative min-h-0 min-w-0", className)}>{children}</main>;
}

/**
 * The centered 46 rem content lane of a main area (`layout.md`: the new-task column, and the chat
 * lane in stage B). It is structural, like MainPanel: modules own the vertical placement and the
 * spacing around it.
 */
export function ContentLane({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex w-full max-w-[46rem] flex-col", className)}>{children}</div>;
}

/** Size containment makes composer caps follow available content, not the window plus chrome. */
export function TaskContent({ children }: { children: ReactNode }) {
  return (
    <section
      role="region"
      aria-label="task content"
      className="relative min-h-0 flex-1 [container-type:size]"
    >
      {children}
    </section>
  );
}
