import type { ComponentProps } from "react";
import { buttonVariants } from "./button.tsx";

/** Base UI Button would give an anchor role=button; links keep native link semantics. */
export function TextLink(props: Omit<ComponentProps<"a">, "className" | "style">) {
  return <a className={buttonVariants({ variant: "link" })} {...props} />;
}
