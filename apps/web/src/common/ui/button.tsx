import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-(--control-radius) border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-transform ease-surface select-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:not-aria-[haspopup]:translate-y-px motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "text-primary-text underline-offset-4 hover:underline",
      },
      layout: {
        default: "",
        // A full-width row inside a scroll container rings inset, so the strip cannot clip it.
        tree: "min-w-0 flex-1 justify-start overflow-hidden text-left focus-visible:ring-inset",
        navigation:
          "w-full min-w-0 justify-start overflow-hidden text-left focus-visible:ring-inset",
        model: "min-w-0 max-w-64 justify-start overflow-hidden text-left",
        // A plain text control in a context row: content width up to a readable bound, then truncates.
        text: "min-w-0 max-w-64 justify-start overflow-hidden text-left",
        // A session tab takes its content width up to 200 px and the strip's height, then truncates
        // (`layout.md`).
        tab: "h-full min-w-0 max-w-50 justify-start overflow-hidden text-left focus-visible:ring-inset",
        // A footer status line shares the row with other occupants and truncates its label.
        status: "min-w-0 flex-1 justify-start overflow-hidden focus-visible:ring-inset",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        // Two-line sidebar task row (`layout.md`, **Sidebar**: 52 px, content decides the rest).
        row: "min-h-13 gap-2 px-2 py-1.5",
        // Dense single-line list row (ChangeFileRow): the height and width of the row it fills.
        "row-sm": "min-h-7 w-full gap-2 rounded-sm px-2",
        icon: "size-8",
        "icon-micro": "size-5 rounded-sm p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  layout = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, layout, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
