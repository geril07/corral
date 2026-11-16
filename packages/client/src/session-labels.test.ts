import type { Session } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { sessionLabels } from "./session-labels.ts";

const shell = (id: string): Session => ({
  id,
  taskId: "t1",
  kind: "shell",
  view: "terminal",
  agentSessionId: null,
  terminalId: `term-${id}`,
  state: "running",
  status: null,
  createdAt: 0,
});

const claude = (id: string): Session => ({ ...shell(id), kind: "claude", agentSessionId: id });

test("a session is named by its kind", () => {
  expect(sessionLabels([shell("1"), claude("2")])).toEqual(
    new Map([
      ["1", "shell"],
      ["2", "claude"],
    ]),
  );
});

test("copies of one kind share the bare kind instead of carrying an index", () => {
  expect(sessionLabels([shell("1"), claude("2"), shell("3"), shell("4")])).toEqual(
    new Map([
      ["1", "shell"],
      ["2", "claude"],
      ["3", "shell"],
      ["4", "shell"],
    ]),
  );
});

test("a name the user gave a session stands in for its kind", () => {
  expect(sessionLabels([{ ...shell("1"), label: "build" }, claude("2"), shell("3")])).toEqual(
    new Map([
      ["1", "build"],
      ["2", "claude"],
      ["3", "shell"],
    ]),
  );
});

test("taking a name away or leaving it blank brings the kind back", () => {
  expect(sessionLabels([{ ...shell("1"), label: null }, shell("2")])).toEqual(
    new Map([
      ["1", "shell"],
      ["2", "shell"],
    ]),
  );
  expect(sessionLabels([{ ...shell("1"), label: "   " }, shell("2")])).toEqual(
    new Map([
      ["1", "shell"],
      ["2", "shell"],
    ]),
  );
});
