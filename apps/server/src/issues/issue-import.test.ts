import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { useFakeIssueClis } from "../../test/issue-clis.ts";
import { IssueImportService } from "./issue-import.ts";

const clis = useFakeIssueClis();

test("a pre-aborted signal rejects before any CLI starts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corral-issue-cwd-"));
  try {
    const service = new IssueImportService({ timeoutMs: 10_000 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.resolve(cwd, { url: "https://github.com/acme/app/issues/1" }, controller.signal),
    ).rejects.toThrow(/abort/i);
    expect(clis.calls()).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancelling an import kills the CLI instead of leaving it running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "corral-issue-cwd-"));
  try {
    const pidFile = clis.hang();
    const service = new IssueImportService({ timeoutMs: 10_000 });
    const controller = new AbortController();

    const resolving = service.resolve(
      cwd,
      { url: "https://github.com/acme/app/issues/1" },
      controller.signal,
    );
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    controller.abort();

    await expect(resolving).rejects.toThrow(/abort/i);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
