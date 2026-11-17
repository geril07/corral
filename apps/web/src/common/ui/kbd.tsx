import { cn } from "../lib/cn.ts";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="kbd" className={cn("visual-keycap", className)} {...props} />;
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="kbd-group" className={cn("visual-keycaps", className)} {...props} />;
}

export { Kbd, KbdGroup };
