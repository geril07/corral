import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { Field, FieldLabel } from "./field.tsx";
import { RadioGroupItem } from "./radio-group.tsx";

/** Connects the stock field label to the single control without repeating generated ids. */
export function FormField({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {cloneElement(children, { id })}
    </Field>
  );
}

/** A radio and its label keep the same stock field layout in each domain picker. */
export function RadioChoice({ children, ...props }: React.ComponentProps<typeof RadioGroupItem>) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <RadioGroupItem id={id} {...props} />
      <FieldLabel htmlFor={id}>{children}</FieldLabel>
    </Field>
  );
}
