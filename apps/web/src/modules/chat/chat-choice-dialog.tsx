import type { ChatStore } from "@corral/client/chat-store";
import { describeError } from "@corral/client/rpc-errors";
import type { ChatModelRef } from "@corral/protocol/chat";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  FormError,
  TaskCommandDialog,
} from "../../common/ui/index.ts";
import { chatModelKey } from "./chat-choices.ts";

export interface ChatChoiceDialogProps {
  store: ChatStore;
  /** Which of the session state's two lists to show. */
  kind: "model" | "reasoning";
  onSetModel: (model: ChatModelRef) => Promise<void>;
  onSetReasoning: (level: string) => Promise<void>;
  onClose: () => void;
}

/**
 * The model or reasoning-level chooser (`layout.md`, **Chat**): one keyboard-first list of what
 * the driver reported, opened from the composer row and from the palette's action. Typing
 * filters, Enter applies, and a refused choice keeps the dialog open with the server's sentence.
 */
export function ChatChoiceDialog({
  store,
  kind,
  onSetModel,
  onSetReasoning,
  onClose,
}: ChatChoiceDialogProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot).state;
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The keyboard goes to the list after the dialog that opened this one has unmounted: a palette
  // action replaces the palette with this chooser, and the palette's focus restore runs first.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const choose = async (key: string) => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      if (kind === "model") {
        const model = state.models.find((candidate) => chatModelKey(candidate) === key);
        if (model !== undefined) await onSetModel({ provider: model.provider, id: model.id });
      } else {
        await onSetReasoning(key);
      }
      onClose();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const current =
    kind === "model" ? ((state.model && chatModelKey(state.model)) ?? "") : (state.reasoning ?? "");
  const items =
    kind === "model"
      ? state.models.map((model) => ({
          key: chatModelKey(model),
          label: model.name,
          detail: model.name === model.id ? undefined : `${model.provider ?? ""}/${model.id}`,
        }))
      : state.reasoningLevels.map((level) => ({ key: level, label: level, detail: undefined }));
  const title = kind === "model" ? "Chat model" : "Reasoning level";
  const empty =
    kind === "model" ? "This agent reports no models." : "This agent reports no reasoning levels.";

  return (
    <TaskCommandDialog title={title} onClose={onClose}>
      <Command label={title} loop>
        <CommandInput
          ref={inputRef}
          aria-label={`Search ${kind === "model" ? "models" : "levels"}`}
        />
        {failure !== undefined && <FormError>{failure}</FormError>}
        <CommandList>
          {items.length === 0 ? (
            <CommandEmpty>{empty}</CommandEmpty>
          ) : (
            <CommandGroup heading={title}>
              {items.map((item) => (
                <CommandItem
                  key={item.key}
                  value={`${item.key} ${item.label}`}
                  onSelect={() => void choose(item.key)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.key === current ? (
                    <span className="text-xs text-muted-foreground">current</span>
                  ) : (
                    item.detail !== undefined && (
                      <span className="max-w-1/2 truncate text-xs text-muted-foreground">
                        {item.detail}
                      </span>
                    )
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </TaskCommandDialog>
  );
}
