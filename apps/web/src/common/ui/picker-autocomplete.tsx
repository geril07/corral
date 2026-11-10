import { Autocomplete } from "@base-ui/react/autocomplete";
import {
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  PICKER_INPUT_CLASS,
  PICKER_LIST_CLASS,
  PickerFrame,
  type PickerFrameMessage,
} from "./picker-frame.tsx";
import { usePickerArrowWrap } from "./picker-navigation.ts";

/** One option row: the list owns hover and keyboard-highlight backgrounds. */
const OPTION_CLASS =
  "group/picker-row flex min-w-0 cursor-default items-center gap-2 rounded-sm px-2 text-sm data-highlighted:bg-accent hover:bg-accent";

export interface PickerAutocompleteProps<K> {
  /** The visible group label and the list's accessible name. */
  label: string;
  inputLabel: string;
  placeholder?: string | undefined;
  items: readonly K[];
  /** The input text; the caller owns it and receives every edit. */
  query: string;
  onQueryChange: (query: string) => void;
  /** `null` when the caller already filtered the items (the path picker's server answers). */
  filter: ((item: K, query: string) => boolean) | null;
  /** The text Base UI uses for an item's value and its accessibility fallback. */
  itemToStringValue: (item: K) => string;
  itemKey?: ((item: K) => string) | undefined;
  /** The option's own name, kept free of trailing controls nested in the row. */
  itemLabel?: ((item: K) => string) | undefined;
  renderItem: (item: K) => ReactNode;
  /** The trailing input action, which may reflect whether a row is highlighted. */
  renderAction?: ((active: K | undefined) => ReactNode) | undefined;
  onChoose: (item: K) => void;
  /** Enter with no highlight still reaches the caller; the caller decides what that means. */
  onEnter: (active: K | undefined) => void;
  onClose: () => void;
  /** Extra keys are handled before the autocomplete's own Escape, arrows and Enter. */
  onInputKeyDown?:
    | ((event: KeyboardEvent<HTMLInputElement>, active: K | undefined) => void)
    | undefined;
  inputProps?: ComponentProps<typeof Autocomplete.Input> | undefined;
  inputRef?: RefObject<HTMLInputElement | null> | undefined;
  /** A new key rebuilds the list and drops its highlight and scroll. */
  resetKey?: number | string | undefined;
  message?: PickerFrameMessage | undefined;
}

/**
 * One inline autocomplete picker: Base UI owns virtual focus, filtering, arrow navigation, the
 * loop's wrap and scroll-into-view, and the combobox/listbox/option ARIA. The caller supplies the
 * data and the row contents; the shared frame supplies the picker environment.
 */
export function PickerAutocomplete<K>({
  label,
  inputLabel,
  placeholder,
  items,
  query,
  onQueryChange,
  filter,
  itemToStringValue,
  itemKey,
  itemLabel,
  renderItem,
  renderAction,
  onChoose,
  onEnter,
  onClose,
  onInputKeyDown,
  inputProps,
  inputRef,
  resetKey,
  message,
}: PickerAutocompleteProps<K>) {
  const ownInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownInput;
  const visibleItems = filter === null ? items : items.filter((item) => filter(item, query));
  const { active, noteKey, onItemHighlighted } = usePickerArrowWrap({
    items: visibleItems,
    query,
    inputRef: input,
  });
  return (
    <Autocomplete.Root
      key={resetKey}
      inline
      open
      items={items}
      filter={filter}
      value={query}
      onValueChange={onQueryChange}
      onItemHighlighted={onItemHighlighted}
      itemToStringValue={itemToStringValue}
      autoHighlight={false}
      highlightItemOnHover={false}
    >
      <PickerFrame
        input={
          <Autocomplete.Input
            {...inputProps}
            ref={input}
            className={PICKER_INPUT_CLASS}
            aria-label={inputLabel}
            placeholder={placeholder}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              onInputKeyDown?.(event, active);
              if (event.defaultPrevented) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
                return;
              }
              noteKey(event);
              if (event.key === "Enter") {
                event.preventDefault();
                onEnter(active);
              }
            }}
          />
        }
        action={renderAction?.(active)}
        label={label}
        list={
          <Autocomplete.List className={PICKER_LIST_CLASS} aria-label={label}>
            {(item: K) => (
              <Autocomplete.Item
                key={(itemKey ?? ((value: K) => String(value)))(item)}
                value={item}
                aria-label={itemLabel?.(item)}
                className={OPTION_CLASS}
                onClick={() => onChoose(item)}
              >
                {renderItem(item)}
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        }
        message={message}
      />
    </Autocomplete.Root>
  );
}
