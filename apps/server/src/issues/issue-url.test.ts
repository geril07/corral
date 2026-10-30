import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";
import {
  InvalidIssueUrlError,
  IssueProviderRequiredError,
  IssueUnsupportedPortError,
} from "./errors.ts";
import { parseIssueUrl } from "./issue-url.ts";

test("GitHub, ghe.com and GitLab URLs become a canonical issue identity", () => {
  expect(parseIssueUrl("https://github.com/acme/app/issues/42")).toEqual({
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 42,
    url: "https://github.com/acme/app/issues/42",
  });
  expect(parseIssueUrl("https://acme.ghe.com/acme/app/issues/7?tab=1#note")).toMatchObject({
    provider: "github",
    host: "acme.ghe.com",
    url: "https://acme.ghe.com/acme/app/issues/7",
  });
  expect(parseIssueUrl("http://gitlab.com/group/sub/project/-/issues/0042#note", "gitlab")).toEqual(
    {
      provider: "gitlab",
      host: "gitlab.com",
      repository: "group/sub/project",
      number: 42,
      url: "http://gitlab.com/group/sub/project/-/issues/42",
    },
  );
});

test("a self-hosted host needs its provider named and keeps its port", () => {
  const url = "https://gitlab.example.com:8443/group/project/-/issues/3";
  expect(() => parseIssueUrl(url)).toThrow(IssueProviderRequiredError);
  expect(parseIssueUrl(url, "gitlab")).toMatchObject({
    provider: "gitlab",
    host: "gitlab.example.com:8443",
    repository: "group/project",
    number: 3,
    url,
  });
  expect(parseIssueUrl("http://ghe.example.com/acme/app/issues/9", "github")).toMatchObject({
    provider: "github",
    host: "ghe.example.com",
    url: "http://ghe.example.com/acme/app/issues/9",
  });
});

test("GitHub issue URLs on a nonstandard port are refused, while GitLab keeps its exact port", () => {
  expect(() => parseIssueUrl("https://ghe.example.com:8443/acme/app/issues/9", "github")).toThrow(
    IssueUnsupportedPortError,
  );
  expect(
    parseIssueUrl("https://gitlab.example.com:8443/group/project/-/issues/3", "gitlab"),
  ).toMatchObject({ host: "gitlab.example.com:8443" });
});

test("a known host rejects the other provider", () => {
  expect(() => parseIssueUrl("https://github.com/acme/app/issues/1", "gitlab")).toThrow(
    /GitHub, not GitLab/,
  );
  expect(() => parseIssueUrl("https://gitlab.com/group/app/-/issues/1", "github")).toThrow(
    /GitLab, not GitHub/,
  );
});

test("non-issue, credential-bearing, option-like and malformed URLs are refused", () => {
  const urls = [
    "not a url",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@github.com/acme/app/issues/1",
    "https://github.com/acme/app/pull/1",
    "https://github.com/acme/app/issues/1/extra",
    "https://github.com/-acme/app/issues/1",
    "https://github.com/-/app/issues/1",
    "https://github.com/acme/app/issues/-1",
    "https://github.com/acme/app/issues/0",
    "https://github.com/acme/app/issues/99999999999",
    "https://github.com/acme/app/issues/1%2F..",
    "https://github.com/acme/app/issues/%2e%2e",
    "https://gitlab.com/group/project/issues/1",
    "https://gitlab.com/-/issues/1",
    "https://gitlab.com/group/project/-/issues/1/-/issues/2",
  ];
  for (const url of urls) {
    expect(() => parseIssueUrl(url)).toThrow(InvalidIssueUrlError);
  }
});

test("arbitrary text either fails with our domain errors or yields a safe, stable identity", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 200 }), (text) => {
      let ref: ReturnType<typeof parseIssueUrl>;
      try {
        ref = parseIssueUrl(text);
      } catch (error) {
        if (
          !(error instanceof InvalidIssueUrlError) &&
          !(error instanceof IssueProviderRequiredError) &&
          !(error instanceof IssueUnsupportedPortError)
        )
          throw error;
        return;
      }
      expect(ref.url.startsWith("http://") || ref.url.startsWith("https://")).toBe(true);
      expect(ref.url).not.toContain("@");
      expect(ref.url.startsWith("-")).toBe(false);
      expect(parseIssueUrl(ref.url, ref.provider)).toEqual(ref);
    }),
  );
});
