import { expect, test } from "vite-plus/test";
import { remoteDestination } from "./remotes.ts";

test("a forge URL names the repository the CLI is pointed at", () => {
  expect(remoteDestination("https://github.com/acme/app.git")).toEqual({
    host: "github.com",
    segments: ["acme", "app"],
  });
  expect(remoteDestination("https://GitLab.example.com/acme/app")).toEqual({
    host: "gitlab.example.com",
    segments: ["acme", "app"],
  });
  // A nested GitLab group is a repository path, not a host.
  expect(remoteDestination("https://gitlab.com/group/sub/app.git")).toEqual({
    host: "gitlab.com",
    segments: ["group", "sub", "app"],
  });
  expect(remoteDestination("ssh://git@forge.example.com:2222/acme/app.git")).toEqual({
    host: "forge.example.com",
    segments: ["acme", "app"],
  });
  expect(remoteDestination("git@forge.example.com:acme/app.git")).toEqual({
    host: "forge.example.com",
    segments: ["acme", "app"],
  });
  expect(remoteDestination("git://forge.example.com/acme/app")).toEqual({
    host: "forge.example.com",
    segments: ["acme", "app"],
  });
});

test("a destination that is not a forge repository has no --repo", () => {
  // The suite's own remote: a local path, which no CLI can be pointed at by name.
  expect(remoteDestination("/tmp/corral/remote/origin.git")).toBeUndefined();
  expect(remoteDestination("file:///tmp/corral/remote/origin.git")).toBeUndefined();
  expect(remoteDestination("../origin.git")).toBeUndefined();
  // A port is not part of gh's [HOST/]OWNER/REPO form.
  expect(remoteDestination("https://forge.example.com:8443/acme/app.git")).toBeUndefined();
  // No repository path at all.
  expect(remoteDestination("https://forge.example.com/app.git")).toBeUndefined();
  expect(remoteDestination("https://forge.example.com/")).toBeUndefined();
  // Credentials must never reach an argv.
  expect(remoteDestination("https://user:token@forge.example.com/acme/app.git")).toBeUndefined();
  expect(remoteDestination("not a url")).toBeUndefined();
  // A path segment that could be read as an option.
  expect(remoteDestination("https://forge.example.com/acme/--upload-pack")).toEqual({
    host: "forge.example.com",
    segments: ["acme", "--upload-pack"],
  });
});
