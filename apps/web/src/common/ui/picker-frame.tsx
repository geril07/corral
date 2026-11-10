import type { ReactNode } from "react";

/**
 * The one row-box-free field appearance in the picker frame: PathPicker's autocomplete input and
 * the project picker's search field are the same 48 px row, never an inset rounded box. Focus
 * decoration belongs to neither: the caret is the indicator.
 */
const PICKER_INPUT_CLASS =
  "visual-path-input h-12 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-sm outline-none dark:bg-transparent";
/** The one scrolling list inside the frame; the gap lives in the frame, not here. */
const PICKER_LIST_CLASS = "visual-path-list max-h-72 overflow-y-auto px-2";

/** One row under the list: a settled empty result or a settled error. */
export interface PickerFrameMessage {
  text: ReactNode;
  error?: boolean | undefined;
}

/**
 * The Add project environment. The field is one bordered row rather than an inset box, the list
 * scrolls inside its own frame so rows clip at the edge, and a settled empty or error answer is
 * one message row under the list. Both path and project pickers render through it, so the frame
 * has one definition; only the row contents and the field wiring differ.
 */
export function PickerFrame({
  input,
  action,
  label,
  list,
  message,
}: {
  /** The field element; the picker autocomplete owns its appearance. */
  input: ReactNode;
  /** A trailing action in the input row, such as path-picker's Add. */
  action?: ReactNode | undefined;
  label: string;
  /** The list's scrolling element; omitted when a message replaces it. */
  list?: ReactNode | undefined;
  message?: PickerFrameMessage | undefined;
}) {
  return (
    <>
      <div className="visual-path-input-row flex items-center gap-2 border-b px-4">
        {input}
        {action}
      </div>
      <div className="px-4 pt-3 text-xs text-muted-foreground">{label}</div>
      {list !== undefined && <div className="visual-path-list-frame">{list}</div>}
      {(list === undefined || message !== undefined) && (
        <div className="visual-path-message-row">
          <div
            className="visual-path-message"
            data-slot="path-picker-message"
            role={message === undefined ? undefined : message.error === true ? "alert" : "status"}
            data-error={message?.error === true ? "" : undefined}
          >
            {message !== undefined && (
              <span title={typeof message.text === "string" ? message.text : undefined}>
                {message.text}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export { PICKER_INPUT_CLASS, PICKER_LIST_CLASS };
