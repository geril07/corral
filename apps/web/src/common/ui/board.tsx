import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";
import { itemVariants } from "./item.tsx";

export function BoardList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn("m-0 flex-1 list-none overflow-y-auto p-0", className)} {...props} />;
}

/** Keep the board's five columns while using the stock Item appearance and focus treatment. */
export function BoardRow({ className, children, ...props }: ComponentProps<"li">) {
  return (
    <li
      className={cn(
        itemVariants({ variant: props["aria-selected"] ? "muted" : "default" }),
        className,
      )}
      {...props}
    >
      <div className="grid w-full grid-cols-[18px_140px_minmax(0,1.5fr)_minmax(0,2.5fr)_44px] items-center gap-2.5">
        {children}
      </div>
    </li>
  );
}
