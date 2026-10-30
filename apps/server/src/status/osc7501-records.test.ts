// Cases ported from Orca's `src/shared/program-status/records.test.ts` (MIT, Copyright (c) 2026 Lovecast Inc.).
import { expect, test } from "vite-plus/test";
import { MAX_RECORDS, Osc7501Records } from "./osc7501-records.ts";

test("a report replaces its record whole", () => {
  const records = new Osc7501Records();
  records.apply({ id: null, state: "working", msg: "Installing" }, 1);
  records.apply({ id: null, state: "done" }, 2);
  expect(records.status()).toEqual({ state: "done", updatedAt: 2 });
});

test("clearing an id removes it and everything beneath it; a bare clear removes all", () => {
  const records = new Osc7501Records();
  records.apply({ id: null, state: "working" }, 1);
  records.apply({ id: "build", state: "blocked" }, 2);
  records.apply({ id: "build/test", state: "blocked" }, 3);
  records.apply({ id: "builder", state: "blocked", msg: "sibling with a similar name" }, 4);
  expect(records.apply({ id: "build", state: "clear" }, 5)).toBe(true);
  expect(records.status()).toMatchObject({
    state: "blocked",
    message: "sibling with a similar name",
  });
  expect(records.apply({ id: null, state: "clear" }, 6)).toBe(true);
  expect(records.status()).toBeNull();
});

test("when the program ends, working, blocked and idle go but done and error stay", () => {
  const records = new Osc7501Records();
  records.apply({ id: null, state: "blocked", kind: "question" }, 1);
  records.apply({ id: "a", state: "done" }, 2);
  records.apply({ id: "c", state: "idle" }, 3);
  expect(records.endProgram()).toBe(true);
  expect(records.status()).toBeNull();
  records.apply({ id: null, state: "error", msg: "boom" }, 4);
  expect(records.endProgram()).toBe(false);
  expect(records.status()).toMatchObject({ state: "error", message: "boom" });
});

test("the least recently updated record is evicted past the cap", () => {
  const records = new Osc7501Records();
  records.apply({ id: null, state: "working" }, 0);
  for (let i = 0; i < MAX_RECORDS; i += 1) records.apply({ id: `r${i}`, state: "working" }, i);
  expect(records.status()).toBeNull();
  records.apply({ id: "r0", state: "blocked" }, 1);
  expect(records.status()).toMatchObject({ state: "blocked" });
});

test("a status is the root record: its state, the kind of a block, its message and when it was reported", () => {
  const records = new Osc7501Records();
  records.apply({ id: null, state: "blocked", kind: "permission", msg: "Run rm -rf?" }, 42);
  expect(records.status()).toEqual({
    state: "blocked",
    kind: "permission",
    message: "Run rm -rf?",
    updatedAt: 42,
  });
});

test("a blocked subagent makes the session blocked, with its kind and message; the longest-waiting one wins", () => {
  const records = new Osc7501Records();
  records.apply({ id: null, state: "working", msg: "Refactoring" }, 1);
  records.apply({ id: "agent1", state: "working" }, 2);
  expect(records.status()).toMatchObject({ state: "working", message: "Refactoring" });

  records.apply({ id: "agent2", state: "blocked", kind: "question", msg: "Which database?" }, 3);
  records.apply({ id: "agent1", state: "blocked", kind: "permission", msg: "Write file?" }, 4);
  expect(records.status()).toEqual({
    state: "blocked",
    kind: "question",
    message: "Which database?",
    updatedAt: 3,
  });

  records.apply({ id: "agent2", state: "clear" }, 5);
  expect(records.status()).toMatchObject({ state: "blocked", kind: "permission" });
  records.apply({ id: "agent1", state: "working" }, 6);
  expect(records.status()).toMatchObject({ state: "working", message: "Refactoring" });
});

test("a blocked root outranks a blocked subagent", () => {
  const records = new Osc7501Records();
  records.apply({ id: "agent", state: "blocked", msg: "child" }, 1);
  records.apply({ id: null, state: "blocked", msg: "root" }, 2);
  expect(records.status()).toMatchObject({ message: "root" });
});

test("subagents alone do not make a status unless one is blocked", () => {
  const records = new Osc7501Records();
  records.apply({ id: "agent", state: "working" }, 1);
  expect(records.status()).toBeNull();
  records.apply({ id: "agent", state: "blocked" }, 2);
  expect(records.status()).toMatchObject({ state: "blocked" });
});
