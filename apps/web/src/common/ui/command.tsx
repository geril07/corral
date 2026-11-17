"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "../lib/cn.ts";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog.tsx";
import { SearchIcon } from "lucide-react";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive data-slot="command" className={cn("visual-command", className)} {...props} />
  );
}

function CommandDialog({
  title = "Command Palette",
  description,
  children,
  className,
  showCloseButton = false,
  finalFocus,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string;
  /** Only a dialog that has a sentence of its own gets one; a palette's list speaks for itself. */
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  finalFocus?: React.ComponentProps<typeof DialogContent>["finalFocus"];
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        {description !== undefined && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <DialogContent
        className={cn("visual-palette visual-dialog-anchored", className)}
        padding="none"
        showCloseButton={showCloseButton}
        finalFocus={finalFocus}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="visual-search-band">
      <SearchIcon aria-hidden="true" className="visual-search-band-icon" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn("visual-search-band-input", className)}
        {...props}
      />
    </div>
  );
}

function CommandList({
  className,
  variant = "content",
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List> & {
  /**
   * `fixed` holds one box whatever the result count, so a palette never resizes while it filters;
   * `content` shrinks to its rows.
   */
  variant?: "content" | "fixed";
}) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      data-variant={variant}
      className={cn("visual-palette-list", className)}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("visual-palette-empty", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn("visual-palette-group", className)}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("visual-palette-separator", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn("visual-palette-item", className)}
      {...props}
    >
      {children}
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("visual-palette-shortcut", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
