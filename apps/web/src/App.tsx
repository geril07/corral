import { matchesChord, parseChord } from "@corral/client/keymap";
import { useEffect, useState } from "react";

/** Shows when prefix mode is armed: the prefix chord was pressed and the next key is an action. */
export function App({ prefix }: { prefix: string }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const chord = parseChord(prefix);
    const onKeyDown = (event: KeyboardEvent) => {
      if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
      setArmed((wasArmed) => !wasArmed && matchesChord(event, chord));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prefix]);

  return (
    <main>
      <h1>Corral</h1>
      {armed && <output aria-label="prefix mode">prefix</output>}
    </main>
  );
}
