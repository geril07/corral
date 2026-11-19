import {
  customSnoozeUntil,
  localSnoozeDate,
  localSnoozeTime,
  type CustomSnoozeInput,
} from "@corral/client/snooze";
import { useState, type ComponentProps, type FormEvent } from "react";
import {
  Button,
  DialogActions,
  FormError,
  FormField,
  Input,
  SegmentedControl,
  SegmentedOption,
  TaskDialog,
} from "../../common/ui/index.ts";

const HOUR_MS = 60 * 60 * 1000;

interface SnoozeDialogProps {
  /** The task's title, for the dialog's heading. */
  taskTitle: string;
  /** Resolves to `null` once the server stored the wake time, else the sentence to show. */
  onSnooze: (snoozedUntil: number) => Promise<string | null>;
  /** The row that opened the dialog; the caller names the live element. */
  finalFocus?: ComponentProps<typeof TaskDialog>["finalFocus"];
  onClose: () => void;
}

/**
 * A wake time the presets do not name: a local date and time, or a duration from now. Both modes
 * resolve through `customSnoozeUntil`, so the rule for "a future time, at most 30 days out" is one
 * definition, and a refusal stays in the dialog with the server's own sentence.
 */
export function SnoozeDialog({ taskTitle, onSnooze, finalFocus, onClose }: SnoozeDialogProps) {
  // The reference opens on a real time: now plus an hour, not an empty picker.
  const [initial] = useState(() => new Date(Date.now() + HOUR_MS));
  // The native picker refuses past days; a dialog left open past midnight is still caught on submit.
  const [today] = useState(() => localSnoozeDate(new Date()));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() => localSnoozeDate(initial));
  const [time, setTime] = useState(() => localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [problem, setProblem] = useState<string>();
  const [pending, setPending] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const input: CustomSnoozeInput =
      mode === "duration" ? { mode, amount, unit } : { mode, date, time };
    const until = customSnoozeUntil(input, new Date());
    if (until === null) {
      setProblem(
        mode === "date"
          ? "Choose a valid date and time in the future, within 30 days."
          : "Enter a duration between 1 minute and 30 days.",
      );
      return;
    }
    setProblem(undefined);
    setPending(true);
    const refusal = await onSnooze(until);
    if (refusal === null) {
      onClose();
      return;
    }
    setProblem(refusal);
    setPending(false);
  };

  return (
    <TaskDialog
      title={`Snooze "${taskTitle}"`}
      description="Choose when this task returns to the active list."
      finalFocus={finalFocus}
      beforeClose={() => !pending}
      onClose={onClose}
    >
      {/* The dialog owns the wording of a bad time, so the browser must not answer first. */}
      <form noValidate className="grid gap-4" onSubmit={(event) => void save(event)}>
        <SegmentedControl
          aria-label="Snooze by"
          value={mode}
          onValueChange={(value) => {
            setMode(value === "duration" ? "duration" : "date");
            setProblem(undefined);
          }}
        >
          <SegmentedOption value="date">Date and time</SegmentedOption>
          <SegmentedOption value="duration">Duration</SegmentedOption>
        </SegmentedControl>
        {mode === "date" ? (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Date">
              <Input
                type="date"
                required
                value={date}
                min={today}
                onChange={(event) => {
                  setDate(event.target.value);
                  setProblem(undefined);
                }}
              />
            </FormField>
            <FormField label="Time">
              <Input
                type="time"
                required
                value={time}
                onChange={(event) => {
                  setTime(event.target.value);
                  setProblem(undefined);
                }}
              />
            </FormField>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <div className="w-24">
              <FormField label="Snooze for">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  required
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setProblem(undefined);
                  }}
                />
              </FormField>
            </div>
            <div className="flex-1">
              <SegmentedControl
                aria-label="Unit"
                value={unit}
                onValueChange={(value) => {
                  setUnit(value === "minutes" || value === "days" ? value : "hours");
                  setProblem(undefined);
                }}
              >
                <SegmentedOption value="minutes">Minutes</SegmentedOption>
                <SegmentedOption value="hours">Hours</SegmentedOption>
                <SegmentedOption value="days">Days</SegmentedOption>
              </SegmentedControl>
            </div>
          </div>
        )}
        {problem !== undefined && <FormError>{problem}</FormError>}
        <DialogActions>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            Snooze
          </Button>
        </DialogActions>
      </form>
    </TaskDialog>
  );
}
