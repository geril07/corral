import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

const boardListClass = "m-0 flex-1 list-none overflow-y-auto p-0 outline-none";

const boardRowClass =
  "grid cursor-pointer grid-cols-[18px_150px_minmax(0,2fr)_minmax(0,3fr)_48px] items-baseline gap-2.5 border-l-2 border-transparent px-2 py-1.5 aria-selected:border-accent aria-selected:bg-surface-active";

export function BoardList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn(boardListClass, className)} {...props} />;
}

export function BoardRow({ className, ...props }: ComponentProps<"li">) {
  return <li className={cn(boardRowClass, className)} {...props} />;
}
