import { commands } from "vite-plus/test/browser";

export interface IssueCliCall {
  command: "gh" | "glab";
  argv: string[];
  cwd: string;
}

// Custom commands are not part of the library's types, which this package cannot augment.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const custom = commands as unknown as {
  issueCliCalls: () => Promise<IssueCliCall[]>;
  clearIssueCliCalls: () => Promise<void>;
  issueCliPath: (kind: "missing" | "with") => Promise<string>;
};

/** Every fake gh/glab launch on the test server so far, oldest first. */
export const issueCliCalls = () => custom.issueCliCalls();

export const clearIssueCliCalls = () => custom.clearIssueCliCalls();

/** A server PATH with the fake gh/glab first (`with`) or with no gh/glab at all (`missing`). */
export const issueCliPath = (kind: "missing" | "with") => custom.issueCliPath(kind);
