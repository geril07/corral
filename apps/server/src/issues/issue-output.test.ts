import { expect, test } from "vite-plus/test";
import { IssueResponseInvalidError } from "./errors.ts";
import { parseIssueOutput } from "./issue-output.ts";
import { parseIssueUrl } from "./issue-url.ts";

const ref = parseIssueUrl("https://github.com/acme/app/issues/42");
const labRef = parseIssueUrl("https://gitlab.com/group/project/-/issues/7");

test("GitHub JSON keeps the issue text, ignores unknown fields and takes the URL from our parse", () => {
  const source = parseIssueOutput(
    "github",
    JSON.stringify({
      number: 42,
      title: "  Fix <script>alert(1)</script> login  ",
      body: "Steps:\n1. run `rm -rf /`\n",
      url: "https://github.com/acme/app/issues/42",
      labels: [{ name: "bug" }],
    }),
    ref,
    1_700_000_000_000,
  );

  expect(source).toEqual({
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 42,
    url: "https://github.com/acme/app/issues/42",
    title: "Fix <script>alert(1)</script> login",
    body: "Steps:\n1. run `rm -rf /`\n",
    fetchedAt: 1_700_000_000_000,
  });
  expect(source.body).not.toContain("evil.example");
});

test("GitLab JSON reads description as the body and a null description as empty", () => {
  expect(
    parseIssueOutput(
      "gitlab",
      JSON.stringify({
        iid: 7,
        title: "Crash",
        description: "Stack trace",
        web_url: "https://gitlab.com/group/project/-/issues/7",
      }),
      labRef,
      1,
    ),
  ).toMatchObject({ provider: "gitlab", title: "Crash", body: "Stack trace" });
  expect(
    parseIssueOutput(
      "gitlab",
      JSON.stringify({
        iid: 7,
        title: "Crash",
        description: null,
        web_url: "https://gitlab.com/group/project/-/issues/7",
      }),
      labRef,
      1,
    ),
  ).toMatchObject({ body: "" });
});

test("malformed or mismatched output is refused as a domain error, never guessed", () => {
  const url = "https://github.com/acme/app/issues/42";
  const cases = [
    "",
    "not json",
    "{}",
    "[]",
    JSON.stringify({ number: 42 }),
    JSON.stringify({ number: 42, title: "   ", body: "x", url }),
    JSON.stringify({ number: 41, title: "Another issue", body: "x", url }),
    JSON.stringify({ number: "42", title: "String number", body: "x", url }),
    JSON.stringify({ number: 42, title: "Missing URL", body: "x" }),
    JSON.stringify({
      number: 42,
      title: "Wrong host",
      body: "x",
      url: "https://evil.example/acme/app/issues/42",
    }),
    JSON.stringify({
      number: 42,
      title: "Wrong repo",
      body: "x",
      url: "https://github.com/acme/other/issues/42",
    }),
    JSON.stringify({
      number: 42,
      title: "Wrong number",
      body: "x",
      url: "https://github.com/acme/app/issues/43",
    }),
    JSON.stringify({ number: 42, title: "Unsafe URL", body: "x", url: "javascript:alert(1)" }),
    JSON.stringify({ number: 42, title: "Too big", body: "x".repeat(1024 * 1024 + 1), url }),
  ];
  for (const text of cases) {
    expect(() => parseIssueOutput("github", text, ref, 1)).toThrow(IssueResponseInvalidError);
  }
  const webUrl = "https://gitlab.com/group/project/-/issues/7";
  const gitlabCases = [
    JSON.stringify({ iid: 6, title: "Another", description: "x", web_url: webUrl }),
    JSON.stringify({ number: 7, title: "Wrong field", description: "x", web_url: webUrl }),
    JSON.stringify({ iid: 7, description: "No title", web_url: webUrl }),
    JSON.stringify({ iid: 7, title: "Missing URL", description: "x" }),
    JSON.stringify({
      iid: 7,
      title: "Wrong repo",
      description: "x",
      web_url: "https://gitlab.com/group/other/-/issues/7",
    }),
  ];
  for (const text of gitlabCases) {
    expect(() => parseIssueOutput("gitlab", text, labRef, 1)).toThrow(IssueResponseInvalidError);
  }
});
