import type { ReactNode } from "react";

/** The shared prompt/chat surface owns its border; its textarea uses frame="composer". */
export function ComposerSurface({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="composer-surface"
      className="overflow-hidden rounded-xl border border-input bg-card/50 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
    >
      {children}
    </div>
  );
}

export function ComposerToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1 px-2 pb-2">{children}</div>;
}
