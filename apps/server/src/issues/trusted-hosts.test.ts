import { expect, test } from "vite-plus/test";
import { envTrustedHosts, hostOfRemote } from "./trusted-hosts.ts";

test("remote hosts keep an HTTP port but drop an SSH transport port", () => {
  expect(hostOfRemote("https://gitlab.example.com:8443/group/project.git")).toBe(
    "gitlab.example.com:8443",
  );
  expect(hostOfRemote("git@github.com:acme/app.git")).toBe("github.com");
  expect(hostOfRemote("ssh://git@ghe.example.com:2222/acme/app.git")).toBe("ghe.example.com");
  expect(hostOfRemote("file:///tmp/repo")).toBeUndefined();
});

test("Windows drives, UNC paths and file: URLs are paths, never scp hosts", () => {
  for (const remote of [
    "C:\\repo",
    "C:/repo",
    "C:repo",
    "\\\\server\\share",
    "//server/share",
    "file:C:\\repo",
  ]) {
    expect(hostOfRemote(remote)).toBeUndefined();
  }
});

test("operator hosts are read only from the provider's documented variables", () => {
  expect(
    envTrustedHosts("github", {
      GH_HOST: "ghe.example.com",
      GITLAB_HOST: "gitlab.example.com",
    }),
  ).toEqual(new Set(["ghe.example.com"]));
  expect(
    envTrustedHosts("gitlab", {
      GH_HOST: "ghe.example.com",
      GITLAB_HOST: "https://gitlab.example.com:8443",
    }),
  ).toEqual(new Set(["gitlab.example.com:8443"]));
});
