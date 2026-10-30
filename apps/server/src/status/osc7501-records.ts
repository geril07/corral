// The records of one terminal's OSC 7501 reports, ported from Orca's
// `src/shared/program-status/records.ts` (MIT, Copyright (c) 2026 Lovecast Inc.).
import type { AgentState, AgentStatus } from "@corral/protocol/rpc";
import { outlivesProgram, type Osc7501Report } from "./osc7501-protocol.ts";

interface Osc7501Record {
  /** Null is the root record. */
  id: string | null;
  state: AgentState;
  kind?: AgentStatus["kind"];
  msg?: string;
  /** Epoch milliseconds of the report that wrote the record. */
  updatedAt: number;
}

/** Spec ceiling; the least recently updated record is evicted past it so a runaway program cannot grow memory. */
export const MAX_RECORDS = 256;

const ROOT_KEY = "";

function isAtOrBeneath(id: string, ancestor: string): boolean {
  return id === ancestor || id.startsWith(`${ancestor}/`);
}

/** Mutators return whether anything changed. */
export class Osc7501Records {
  // Map order doubles as least-recently-updated order: every write re-inserts its key.
  readonly #records = new Map<string, Osc7501Record>();

  apply(report: Osc7501Report, now: number): boolean {
    const key = report.id ?? ROOT_KEY;
    if (report.state === "clear") {
      if (report.id === null) return this.reset();
      let changed = false;
      for (const existing of this.#records.keys()) {
        if (existing !== ROOT_KEY && isAtOrBeneath(existing, key)) {
          this.#records.delete(existing);
          changed = true;
        }
      }
      return changed;
    }
    // Each report replaces its record whole; a field missing here is missing afterwards.
    this.#records.delete(key);
    if (this.#records.size >= MAX_RECORDS) {
      const oldest = this.#records.keys().next().value;
      if (oldest !== undefined) this.#records.delete(oldest);
    }
    this.#records.set(key, {
      id: report.id,
      state: report.state,
      ...(report.kind !== undefined ? { kind: report.kind } : {}),
      ...(report.msg !== undefined ? { msg: report.msg } : {}),
      updatedAt: now,
    });
    return true;
  }

  /** The program ended (a new shell prompt): everything but `done` and `error` goes. */
  endProgram(): boolean {
    let changed = false;
    for (const [key, record] of this.#records) {
      if (!outlivesProgram(record.state)) {
        this.#records.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** A full terminal reset or a root `clear`: every record goes. */
  reset(): boolean {
    const changed = this.#records.size > 0;
    this.#records.clear();
    return changed;
  }

  /**
   * The program's own status is its root record. A blocked subagent outranks it, because the
   * user has to act on that; with several, the one that has waited longest.
   */
  status(): AgentStatus | null {
    const root = this.#records.get(ROOT_KEY);
    const record =
      root?.state === "blocked"
        ? root
        : ([...this.#records].find(
            ([key, { state }]) => key !== ROOT_KEY && state === "blocked",
          )?.[1] ?? root);
    if (!record) return null;
    return {
      state: record.state,
      ...(record.kind !== undefined ? { kind: record.kind } : {}),
      ...(record.msg !== undefined ? { message: record.msg } : {}),
      updatedAt: record.updatedAt,
    };
  }
}
