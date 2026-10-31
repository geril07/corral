import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

const boardListClass = "m-0 flex-1 list-none overflow-y-auto p-0 outline-none";

const boardRowClass =
  "grid min-h-7 cursor-pointer grid-cols-[18px_140px_minmax(0,1.5fr)_minmax(0,2.5fr)_44px] items-center gap-2.5 border-l-2 border-transparent px-2 py-1 text-sm hover:bg-accent/60 aria-selected:border-primary aria-selected:bg-accent";

export function BoardList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn(boardListClass, className)} {...props} />;
}

export function BoardRow({ className, ...props }: ComponentProps<"li">) {
  return <li className={cn(boardRowClass, className)} {...props} />;
}
