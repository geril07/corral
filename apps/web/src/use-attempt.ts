import { useState } from "react";

/** Runs a submit action, tracking whether it is under way and what it failed with. */
export function useAttempt() {
  const [state, setState] = useState<{ pending: boolean; error?: unknown }>({ pending: false });

  const run = async (work: () => Promise<void>) => {
    setState({ pending: true });
    try {
      await work();
      setState({ pending: false });
    } catch (error) {
      setState({ pending: false, error });
    }
  };
  return { pending: state.pending, error: state.error, failed: "error" in state, run };
}
