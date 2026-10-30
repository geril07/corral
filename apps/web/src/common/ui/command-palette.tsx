import { Command as BaseCommand } from "cmdk";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

const rootClass = "flex flex-col outline-none";

const inputClass =
  "h-8 w-full min-w-0 border-b border-border bg-transparent px-1 pb-2 text-text outline-none placeholder:text-text-muted";

const listClass = "mt-2 max-h-72 overflow-y-auto outline-none";

const groupClass =
  "py-1 [&_[cmdk-group-heading]]:px-1 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-text-muted";

const itemClass =
  "flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm text-text outline-none data-[disabled=true]:cursor-default data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-active";

function Root({ className, ...props }: ComponentProps<typeof BaseCommand>) {
  return <BaseCommand className={cn(rootClass, className)} {...props} />;
}

function Input({ className, ...props }: ComponentProps<typeof BaseCommand.Input>) {
  return <BaseCommand.Input className={cn(inputClass, className)} {...props} />;
}

function List({ className, ...props }: ComponentProps<typeof BaseCommand.List>) {
  return <BaseCommand.List className={cn(listClass, className)} {...props} />;
}

function Group({ className, ...props }: ComponentProps<typeof BaseCommand.Group>) {
  return <BaseCommand.Group className={cn(groupClass, className)} {...props} />;
}

function Item({ className, ...props }: ComponentProps<typeof BaseCommand.Item>) {
  return <BaseCommand.Item className={cn(itemClass, className)} {...props} />;
}

function Empty({ className, ...props }: ComponentProps<typeof BaseCommand.Empty>) {
  return <BaseCommand.Empty className={cn("px-2 py-3 text-text-muted", className)} {...props} />;
}

export const CommandPalette = { Root, Input, List, Group, Item, Empty };
