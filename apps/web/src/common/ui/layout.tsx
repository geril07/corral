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

/** A screen that fills the window, for routes without the workspace sidebar. */
export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex h-screen min-h-0 flex-col bg-background", className)}>
      {children}
    </section>
  );
}
