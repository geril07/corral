import type { Session } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { sessionLabels } from "./session-labels.ts";

const shell = (id: string): Session => ({
  id,
  taskId: "t1",
  kind: "shell",
  agentSessionId: null,
  terminalId: `term-${id}`,
  state: "running",
  status: null,
  createdAt: 0,
});

const claude = (id: string): Session => ({ ...shell(id), kind: "claude", agentSessionId: id });

test("a single session of a kind keeps the bare kind as its label", () => {
  expect(sessionLabels([shell("1"), claude("2")])).toEqual(
    new Map([
      ["1", "shell"],
      ["2", "claude"],
    ]),
  );
});

test("copies of one kind after the first are numbered, other kinds are not", () => {
  expect(sessionLabels([shell("1"), claude("2"), shell("3"), shell("4")])).toEqual(
    new Map([
      ["1", "shell"],
      ["2", "claude"],
      ["3", "shell 2"],
      ["4", "shell 3"],
    ]),
  );
});

test("a name the user gave a session stands in for its natural label", () => {
  expect(sessionLabels([{ ...shell("1"), label: "build" }, claude("2"), shell("3")])).toEqual(
    new Map([
      ["1", "build"],
      ["2", "claude"],
      ["3", "shell 2"],
    ]),
  );
});

test("a name given to the first copy does not renumber the others, and taking it away brings the number back", () => {
  const sessions = [shell("1"), shell("2")];
  const named = [{ ...sessions[0]!, label: "build" }, sessions[1]!];
  expect(sessionLabels(named).get("2")).toBe("shell 2");
  expect(sessionLabels([{ ...sessions[0]!, label: null }, sessions[1]!])).toEqual(
    new Map([
      ["1", "shell"],
      ["2", "shell 2"],
    ]),
  );
  expect(sessionLabels([{ ...sessions[0]!, label: "   " }, sessions[1]!])).toEqual(
    new Map([
      ["1", "shell"],
      ["2", "shell 2"],
    ]),
  );
});
