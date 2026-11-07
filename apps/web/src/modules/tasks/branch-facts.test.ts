import { expect, test } from "vite-plus/test";
import {
  branchDrift,
  branchName,
  recordedBranchAccessible,
  recordedBranchLabel,
  recordedBranchParts,
  removalBranchCopy,
} from "./branch-facts.ts";

test("a detached or missing branch name is no branch, never HEAD", () => {
  expect(branchName("feature/x")).toBe("feature/x");
  expect(branchName("")).toBeUndefined();
  expect(branchName("HEAD")).toBeUndefined();
  expect(branchName(null)).toBeUndefined();
  expect(branchName(undefined)).toBeUndefined();
});

test("the recorded label says recorded and spells the qualifier out for the accessible name", () => {
  expect(recordedBranchLabel("feature/x")).toBe("feature/x (recorded)");
  expect(recordedBranchParts("feature/x")).toEqual({ name: "feature/x", qualifier: "(recorded)" });
  expect(recordedBranchLabel("HEAD")).toBe("no branch");
  expect(recordedBranchParts("HEAD")).toEqual({ name: undefined, qualifier: "no branch" });
  expect(recordedBranchLabel("HEAD", "detached")).toBe("detached");
  expect(recordedBranchAccessible("feature/x")).toBe("feature/x (recorded at create)");
  expect(recordedBranchAccessible("")).toBe("no branch checked out at create");
});

test("the drift line names both branches only when the reads name a branch and differ", () => {
  expect(branchDrift("recorded", "renamed")).toBe(
    "Checked out now: renamed · the task was created on recorded.",
  );
  expect(branchDrift("same", "same")).toBeUndefined();
  expect(branchDrift("HEAD", "main")).toBeUndefined();
  expect(branchDrift("recorded", null)).toBeUndefined();
  expect(branchDrift("recorded", undefined)).toBeUndefined();
});

test("Remove names the live branch, says no branch when detached, and stays generic while pending", () => {
  expect(removalBranchCopy("renamed")).toBe("The branch renamed stays.");
  expect(removalBranchCopy(null)).toBe(
    "No branch is checked out in the worktree; branches are not deleted.",
  );
  expect(removalBranchCopy(undefined)).toBe("The branch checked out in the worktree stays.");
});
